// ---------------------------------------------------------------------------
// lib/tools/chain.ts — Concurrent-safe inference and tool execution loops
// ---------------------------------------------------------------------------

import type { Dispatcher } from '../inference/dispatcher';
import type { ToolRegistry } from './registry';
import { parseToolCalls } from './parser';
import type { Message, LLMResponse, ToolExecutionContext, Logger } from '../core/types';

export interface ChainOptions {
  runId?: string;
  maxSteps?: number;
  systemPrompt?: string;
  sessionId?: string | null;
  agentId?: number | null;
  userId?: string;
  requestContext?: any;
  signal?: AbortSignal;
  onStep?: (step: ChainStep) => void;
  [key: string]: any;
}

export interface ChainStep {
  index: number;
  type: 'inference' | 'tool';
  toolName?: string;
  toolParams?: Record<string, any>;
  toolResult?: any;
  response?: LLMResponse;
  durationMs: number;
}

export interface ChainResult {
  runId: string;
  content: string;
  steps: ChainStep[];
  totalSteps: number;
  stopped: boolean;
  aborted: boolean;
}

interface ActiveRun {
  controller: AbortController;
  stopped: boolean;
}

export class ToolChain {
  private _dispatcher: Dispatcher;
  private _registry: ToolRegistry;
  private _runs: Map<string, ActiveRun>;
  private _logger: Logger;
  private _sequence = 0;

  constructor(
    dispatcher: Dispatcher,
    registry: ToolRegistry,
    options: { logger?: Logger } = {}
  ) {
    this._dispatcher = dispatcher;
    this._registry = registry;
    this._runs = new Map();
    this._logger = options.logger ?? console;
  }

  async run(
    message: string,
    history: Message[] = [],
    options: ChainOptions = {}
  ): Promise<ChainResult> {
    const runId = options.runId || 'chain-' + (++this._sequence) + '-' + Date.now();
    if (this._runs.has(runId)) throw new Error('Tool chain run "' + runId + '" is already active');

    const active: ActiveRun = { controller: new AbortController(), stopped: false };
    this._runs.set(runId, active);
    const removeForwarder = forwardAbort(options.signal, active.controller);

    try {
      const maxSteps = options.maxSteps ?? 20;
      const steps: ChainStep[] = [];
      const conversationHistory = [...history];
      let lastContent = '';
      let currentMessage = message;

      for (let index = 0; index < maxSteps; index++) {
        if (active.stopped || active.controller.signal.aborted) {
          return result(runId, lastContent, steps, index, true);
        }

        const inferenceStart = Date.now();
        const response = await this._dispatcher.dispatch(currentMessage, conversationHistory, {
          systemPrompt: options.systemPrompt,
          sessionId: options.sessionId,
          agentId: options.agentId,
          userId: options.userId,
          requestContext: options.requestContext,
          signal: active.controller.signal,
          includeTools: true,
        });

        const inferenceStep: ChainStep = {
          index: steps.length,
          type: 'inference',
          response,
          durationMs: Date.now() - inferenceStart,
        };
        steps.push(inferenceStep);
        options.onStep?.(inferenceStep);
        lastContent = response.content;

        if (active.stopped || active.controller.signal.aborted) {
          return result(runId, lastContent, steps, index + 1, true);
        }

        const calls = parseToolCalls(response.content, new Set(this._registry.names()));
        if (calls.length === 0) {
          return result(runId, lastContent, steps, index + 1, false);
        }

        conversationHistory.push({ role: 'assistant', content: response.content });
        const toolResults: string[] = [];
        for (const call of calls) {
          if (active.stopped || active.controller.signal.aborted) break;

          const toolStart = Date.now();
          const params = toParams(call.arguments);
          const context: ToolExecutionContext = {
            sessionId: options.sessionId,
            agentId: options.agentId,
            runId,
            userId: options.userId,
            requestContext: options.requestContext,
          };
          const execution = await this._registry.execute(call.name, params, context);
          const toolStep: ChainStep = {
            index: steps.length,
            type: 'tool',
            toolName: call.name,
            toolParams: params,
            toolResult: execution.result,
            durationMs: Date.now() - toolStart,
          };
          steps.push(toolStep);
          options.onStep?.(toolStep);

          const text = execution.result?.content
            || execution.result?.error
            || JSON.stringify(execution.result?.result ?? execution.result);
          toolResults.push('[' + call.name + '] ' + text);
        }

        currentMessage = toolResults.join('\n\n');
        conversationHistory.push({ role: 'tool', content: currentMessage });
      }

      return result(runId, lastContent, steps, maxSteps, false);
    } finally {
      removeForwarder();
      this._runs.delete(runId);
    }
  }

  stop(runId?: string): boolean {
    let stopped = false;
    const targets = runId
      ? [[runId, this._runs.get(runId)] as const]
      : Array.from(this._runs.entries());

    for (const [, active] of targets) {
      if (!active || active.stopped) continue;
      active.stopped = true;
      active.controller.abort();
      stopped = true;
    }
    return stopped;
  }

  isRunning(runId?: string): boolean {
    return runId ? this._runs.has(runId) : this._runs.size > 0;
  }
}

function toParams(value: Record<string, any> | string): Record<string, any> {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function result(
  runId: string,
  content: string,
  steps: ChainStep[],
  totalSteps: number,
  stopped: boolean
): ChainResult {
  return {
    runId,
    content,
    steps,
    totalSteps,
    stopped,
    aborted: stopped,
  };
}

function forwardAbort(signal: AbortSignal | undefined, target: AbortController): () => void {
  if (!signal) return () => {};
  const abort = () => target.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}
