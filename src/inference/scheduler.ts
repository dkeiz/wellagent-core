// ---------------------------------------------------------------------------
// lib/inference/scheduler.ts — Inference concurrency scheduler
// ---------------------------------------------------------------------------

import { ScopedSettingsAccessor } from '../core/settings';
import type { SettingsStore, Logger } from '../core/types';

/** Scheduling decision result. */
export interface SchedulingDecision {
  requestedMode: string;
  effectiveMode: 'queued' | 'parallel';
  laneKey: string;
  globalEnabled: boolean;
  needsEnablement: boolean;
}

/**
 * Controls whether inference requests run queued or parallel.
 *
 * Respects:
 * - Global concurrency setting (`llm.concurrency.enabled`)
 * - Per-model capabilities (`modelSpec.capabilities.concurrency`)
 * - Per-provider runtime config (`runtimeConfig.concurrency.allowParallel`)
 *
 * Usage:
 * ```typescript
 * const scheduler = new InferenceScheduler(db);
 * const decision = await scheduler.resolve({
 *   provider: 'ollama',
 *   concurrencyMode: 'parallel',
 *   modelSpec: { capabilities: { concurrency: { supported: true } } },
 *   runtimeConfig: { concurrency: { allowParallel: true } },
 * });
 * // decision.effectiveMode === 'parallel' | 'queued'
 * ```
 */
export class InferenceScheduler extends ScopedSettingsAccessor {
  private _activeLocks: Map<string, { resolve: () => void; promise: Promise<void> }>;
  private _logger: Logger;

  constructor(db: SettingsStore, options: { logger?: Logger } = {}) {
    super(db);
    this._activeLocks = new Map();
    this._logger = options.logger ?? console;
  }

  /**
   * Resolve scheduling decision for a request.
   */
  async resolve(options: {
    provider?: string;
    concurrencyMode?: string;
    modelSpec?: any;
    runtimeConfig?: any;
    requestContext?: any;
    userId?: string;
  } = {}): Promise<SchedulingDecision> {
    const globalEnabled = (await this._getSetting('llm.concurrency.enabled', options)) === 'true';
    const concurrencyCaps = options.modelSpec?.capabilities?.concurrency || {};
    const providerSupportsParallel = Boolean(concurrencyCaps.supported);
    const providerAllowsParallel = Boolean(options.runtimeConfig?.concurrency?.allowParallel);
    const requestedMode = options.concurrencyMode || 'queued';

    if (requestedMode !== 'parallel') {
      return {
        requestedMode,
        effectiveMode: 'queued',
        laneKey: '__global__',
        globalEnabled,
        needsEnablement: false,
      };
    }

    if (!globalEnabled) {
      return {
        requestedMode,
        effectiveMode: 'queued',
        laneKey: '__global__',
        globalEnabled,
        needsEnablement: true,
      };
    }

    if (providerSupportsParallel && providerAllowsParallel) {
      const laneKey = options.provider || '__global__';
      return {
        requestedMode,
        effectiveMode: 'parallel',
        laneKey,
        globalEnabled,
        needsEnablement: false,
      };
    }

    return {
      requestedMode,
      effectiveMode: 'queued',
      laneKey: '__global__',
      globalEnabled,
      needsEnablement: false,
    };
  }

  /**
   * Acquire a lane lock for queued mode. Returns a release function.
   */
  async acquireLane(laneKey: string): Promise<() => void> {
    while (this._activeLocks.has(laneKey)) {
      await this._activeLocks.get(laneKey)!.promise;
    }

    let resolveFn!: () => void;
    const promise = new Promise<void>(resolve => { resolveFn = resolve; });
    this._activeLocks.set(laneKey, { resolve: resolveFn, promise });

    return () => {
      this._activeLocks.delete(laneKey);
      resolveFn();
    };
  }
}
