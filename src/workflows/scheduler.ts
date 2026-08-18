// ---------------------------------------------------------------------------
// lib/workflows/scheduler.ts — Background workflow scheduler
// ---------------------------------------------------------------------------

import type { WorkflowManager, Workflow } from './manager';
import type { WorkflowRuntime } from './runtime';
import type { Logger } from '../core/types';

/**
 * Cron-like background scheduler for workflows.
 *
 * Checks workflow schedules at a fixed interval and triggers runs.
 * Uses simple cron expression matching (minute, hour, day-of-month, month, day-of-week).
 *
 * Usage:
 * ```typescript
 * const scheduler = new WorkflowScheduler(workflowManager, workflowRuntime);
 * scheduler.start(); // Begin checking every 60 seconds
 * // ...
 * scheduler.stop();
 * ```
 */
export class WorkflowScheduler {
  private _workflowManager: WorkflowManager;
  private _runtime: WorkflowRuntime;
  private _interval: ReturnType<typeof setInterval> | null;
  private _checkIntervalMs: number;
  private _lastCheck: Map<string | number, string>;
  private _logger: Logger;

  constructor(
    workflowManager: WorkflowManager,
    runtime: WorkflowRuntime,
    options: { checkIntervalMs?: number; logger?: Logger } = {}
  ) {
    this._workflowManager = workflowManager;
    this._runtime = runtime;
    this._interval = null;
    this._checkIntervalMs = options.checkIntervalMs ?? 60000;
    this._lastCheck = new Map();
    this._logger = options.logger ?? console;
  }

  /**
   * Start the scheduler.
   */
  start(): void {
    if (this._interval) return;
    this._logger.log?.('[WorkflowScheduler] Starting');
    this._interval = setInterval(() => this._tick(), this._checkIntervalMs);
    this._tick(); // Immediate first check
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
      this._logger.log?.('[WorkflowScheduler] Stopped');
    }
  }

  /**
   * Whether the scheduler is running.
   */
  get isRunning(): boolean {
    return this._interval !== null;
  }

  private async _tick(): Promise<void> {
    try {
      const workflows = await this._workflowManager.list();
      const now = new Date();
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

      for (const wf of workflows) {
        if (!wf.enabled || !wf.schedule) continue;

        // Only trigger once per minute per workflow
        const lastKey = this._lastCheck.get(wf.id);
        if (lastKey === minuteKey) continue;

        if (this._matchesCron(wf.schedule, now)) {
          this._lastCheck.set(wf.id, minuteKey);
          this._logger.log?.(`[WorkflowScheduler] Triggering workflow ${wf.id} "${wf.name}"`);

          try {
            await this._runtime.startRun({ workflowId: wf.id });
          } catch (error: any) {
            this._logger.error?.(`[WorkflowScheduler] Failed to start workflow ${wf.id}:`, error?.message);
          }
        }
      }
    } catch (error: any) {
      this._logger.error?.('[WorkflowScheduler] Tick error:', error?.message);
    }
  }

  /**
   * Simple cron expression matching.
   * Supports: minute hour day-of-month month day-of-week
   * Supports: wildcard, numbers, step expressions (every N)
   */
  private _matchesCron(expression: string, date: Date): boolean {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const fields = [
      date.getMinutes(),    // 0-59
      date.getHours(),      // 0-23
      date.getDate(),       // 1-31
      date.getMonth() + 1,  // 1-12
      date.getDay(),        // 0-6 (Sunday=0)
    ];

    for (let i = 0; i < 5; i++) {
      if (!this._matchField(parts[i], fields[i])) return false;
    }

    return true;
  }

  private _matchField(pattern: string, value: number): boolean {
    if (pattern === '*') return true;

    // */N — every N
    if (pattern.startsWith('*/')) {
      const interval = parseInt(pattern.slice(2), 10);
      return Number.isFinite(interval) && interval > 0 && value % interval === 0;
    }

    // Comma-separated values
    const values = pattern.split(',').map(v => parseInt(v.trim(), 10));
    return values.includes(value);
  }
}
