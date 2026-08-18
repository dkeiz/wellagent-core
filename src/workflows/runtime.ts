// ---------------------------------------------------------------------------
// lib/workflows/runtime.ts — Workflow execution engine
// ---------------------------------------------------------------------------

import type { ToolRegistry } from '../tools/registry';
import type { Dispatcher } from '../inference/dispatcher';
import type { WorkflowManager, Workflow } from './manager';
import type { WorkflowRun, WorkflowStepResult, Logger } from '../core/types';
import { EventBus } from '../core/events';
import { generateId } from '../core/config';

/**
 * Executes workflow runs step by step.
 *
 * Usage:
 * ```typescript
 * const runtime = new WorkflowRuntime(workflowManager, toolRegistry, dispatcher);
 * const run = await runtime.startRun({ workflowId: 1 });
 * // Run executes asynchronously, emits events
 * ```
 */
export class WorkflowRuntime {
  private _workflowManager: WorkflowManager;
  private _registry: ToolRegistry;
  private _dispatcher: Dispatcher | null;
  private _eventBus: EventBus | null;
  private _pendingRuns: Map<string, WorkflowRun>;
  private _logger: Logger;

  constructor(
    workflowManager: WorkflowManager,
    registry: ToolRegistry,
    dispatcher?: Dispatcher,
    options: { eventBus?: EventBus; logger?: Logger } = {}
  ) {
    this._workflowManager = workflowManager;
    this._registry = registry;
    this._dispatcher = dispatcher ?? null;
    this._eventBus = options.eventBus ?? null;
    this._pendingRuns = new Map();
    this._logger = options.logger ?? console;
  }

  setEventBus(eventBus: EventBus | null): void {
    this._eventBus = eventBus;
  }

  /**
   * Start a workflow run.
   */
  async startRun(options: {
    workflowId: number | string;
    paramOverrides?: Record<string, any>;
    userId?: string;
    requestContext?: any;
  }): Promise<WorkflowRun> {
    const workflow = await this._workflowManager.get(options.workflowId);
    if (!workflow) throw new Error(`Workflow ${options.workflowId} not found`);

    const runId = generateId('run');
    const run: WorkflowRun = {
      id: runId,
      workflowId: workflow.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      steps: [],
    };

    this._pendingRuns.set(runId, run);
    this._eventBus?.publish('workflow:started', { runId, workflowId: workflow.id });

    // Execute steps
    this._executeSteps(workflow, run, options.paramOverrides || {}, options).catch(error => {
      run.status = 'failed';
      run.error = error?.message || String(error);
      this._eventBus?.publish('workflow:failed', { runId, error: run.error });
    });

    return run;
  }

  private async _executeSteps(
    workflow: Workflow,
    run: WorkflowRun,
    paramOverrides: Record<string, any>,
    options: any
  ): Promise<void> {
    let lastResult: any = null;

    for (const step of workflow.steps) {
      if (run.status === 'cancelled') break;

      const stepStart = Date.now();
      const stepResult: WorkflowStepResult = {
        stepId: step.id || `step-${run.steps!.length}`,
        status: 'completed',
      };

      try {
        if (step.type === 'prompt' && step.prompt && this._dispatcher) {
          // LLM prompt step
          const prompt = this._interpolate(step.prompt, lastResult, paramOverrides);
          const response = await this._dispatcher.dispatch(prompt, [], {
            userId: options.userId,
            requestContext: options.requestContext,
          });
          stepResult.result = response.content;
          lastResult = response.content;

        } else if (step.tool) {
          // Tool execution step
          const params = step.params
            ? JSON.parse(this._interpolate(JSON.stringify(step.params), lastResult, paramOverrides))
            : {};
          const execResult = await this._registry.execute(step.tool, params, {
            userId: options.userId,
            requestContext: options.requestContext,
          });
          stepResult.result = execResult.result;
          lastResult = execResult.result?.content || execResult.result?.result;

          if (execResult.error) {
            stepResult.status = 'failed';
            stepResult.error = execResult.error;
          }
        }
      } catch (error: any) {
        stepResult.status = 'failed';
        stepResult.error = error?.message || String(error);
      }

      stepResult.durationMs = Date.now() - stepStart;
      run.steps!.push(stepResult);

      // Handle step failure
      if (stepResult.status === 'failed' && !step.onFailure) {
        run.status = 'failed';
        run.error = `Step "${stepResult.stepId}" failed: ${stepResult.error}`;
        break;
      }
    }

    if (run.status === 'running') {
      run.status = 'completed';
    }
    run.completedAt = new Date().toISOString();
    run.result = lastResult;

    this._eventBus?.publish('workflow:completed', {
      runId: run.id,
      workflowId: run.workflowId,
      status: run.status,
    });

    this._pendingRuns.delete(run.id);
  }

  /**
   * Cancel a running workflow.
   */
  cancel(runId: string): boolean {
    const run = this._pendingRuns.get(runId);
    if (!run || run.status !== 'running') return false;
    run.status = 'cancelled';
    return true;
  }

  /**
   * Get a run by ID.
   */
  getRun(runId: string): WorkflowRun | null {
    return this._pendingRuns.get(runId) ?? null;
  }

  /**
   * Simple template interpolation: replaces `{{result}}` and `{{param.key}}`.
   */
  private _interpolate(template: string, lastResult: any, params: Record<string, any>): string {
    let output = template;
    output = output.replace(/\{\{result\}\}/g, String(lastResult ?? ''));
    for (const [key, value] of Object.entries(params)) {
      output = output.replace(new RegExp(`\\{\\{param\\.${key}\\}\\}`, 'g'), String(value ?? ''));
    }
    return output;
  }
}
