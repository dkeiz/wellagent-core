// ---------------------------------------------------------------------------
// lib/agents/subagent.ts — Subagent orchestration
// ---------------------------------------------------------------------------

import type { Dispatcher } from '../inference/dispatcher';
import type { ToolRegistry } from '../tools/registry';
import { ToolChain, type ChainOptions, type ChainResult } from '../tools/chain';
import type { Message, Logger } from '../core/types';

/** Configuration for a subagent delegation. */
export interface SubagentConfig {
  name?: string;
  systemPrompt?: string;
  tools?: string[];
  maxSteps?: number;
  timeout?: number;
}

/** Result of a subagent execution. */
export interface SubagentResult {
  content: string;
  steps: number;
  success: boolean;
  error?: string;
  durationMs: number;
}

/**
 * Subagent runtime — delegates tasks to child agent instances.
 *
 * Each subagent gets its own tool chain and can execute autonomously
 * up to a step/time limit, then returns results to the parent.
 *
 * Usage:
 * ```typescript
 * const runtime = new SubagentRuntime(dispatcher, toolRegistry);
 * const result = await runtime.delegate({
 *   name: 'researcher',
 *   systemPrompt: 'You are a research assistant. Find and summarize information.',
 *   tools: ['web_search', 'fetch_url'],
 *   maxSteps: 10,
 * }, 'Research the latest advances in quantum computing');
 * ```
 */
export class SubagentRuntime {
  private _dispatcher: Dispatcher;
  private _registry: ToolRegistry;
  private _activeSubagents: Map<string, { chain: ToolChain; started: number }>;
  private _logger: Logger;

  constructor(
    dispatcher: Dispatcher,
    registry: ToolRegistry,
    options: { logger?: Logger } = {}
  ) {
    this._dispatcher = dispatcher;
    this._registry = registry;
    this._activeSubagents = new Map();
    this._logger = options.logger ?? console;
  }

  /**
   * Delegate a task to a subagent.
   */
  async delegate(
    config: SubagentConfig,
    task: string,
    options: { parentSessionId?: string; parentAgentId?: number; userId?: string; requestContext?: any } = {}
  ): Promise<SubagentResult> {
    const subagentId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const started = Date.now();

    const chain = new ToolChain(this._dispatcher, this._registry, { logger: this._logger });
    this._activeSubagents.set(subagentId, { chain, started });

    const timeout = config.timeout ?? 120000;
    const timeoutSignal = AbortSignal.timeout(timeout);

    try {
      this._logger.log?.(`[Subagent] Starting "${config.name || subagentId}" — task: ${task.slice(0, 100)}`);

      const result = await chain.run(task, [], {
        maxSteps: config.maxSteps ?? 15,
        systemPrompt: config.systemPrompt,
        sessionId: options.parentSessionId,
        agentId: options.parentAgentId,
        userId: options.userId,
        requestContext: options.requestContext,
        signal: timeoutSignal,
      });

      return {
        content: result.content,
        steps: result.totalSteps,
        success: !result.aborted,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        content: '',
        steps: 0,
        success: false,
        error: error?.message || String(error),
        durationMs: Date.now() - started,
      };
    } finally {
      this._activeSubagents.delete(subagentId);
    }
  }

  /**
   * Stop all active subagents.
   */
  stopAll(): void {
    for (const [id, { chain }] of this._activeSubagents) {
      chain.stop();
    }
    this._activeSubagents.clear();
  }

  /**
   * Number of active subagents.
   */
  get activeCount(): number {
    return this._activeSubagents.size;
  }
}
