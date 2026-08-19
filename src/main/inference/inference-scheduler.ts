// @ts-nocheck
class InferenceScheduler {
  constructor({ aiService, db }) {
    this.aiService = aiService;
    this.db = db;
    this.activeLocks = new Map();
    this.laneLocks = new Map();
  }

  _buildScopeOptions(options = {}) {
    const userId = String(options?.userId || '').trim();
    return {
      requestContext: options?.requestContext || null,
      userId: userId || undefined
    };
  }

  async _getSetting(key, options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    if (this.db?.getScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.getScopedSetting(key, scopeOptions);
    }
    return this.db.getSetting(key);
  }

  normalizeConcurrencyMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    return mode === 'parallel' ? 'parallel' : 'queued';
  }

  async resolveSchedulingDecision({ provider, concurrencyMode, modelSpec, runtimeConfig, requestContext = null, userId = null }) {
    const globalEnabled = (await this._getSetting('llm.concurrency.enabled', { requestContext, userId })) === 'true';
    const concurrencyCaps = modelSpec?.capabilities?.concurrency || {};
    const providerSupportsParallel = Boolean(concurrencyCaps.supported);
    const providerAllowsParallel = Boolean(runtimeConfig?.concurrency?.allowParallel);
    const requestedMode = concurrencyMode || 'queued';

    if (requestedMode !== 'parallel') {
      return {
        requestedMode,
        effectiveMode: 'queued',
        laneKey: '__global__',
        globalEnabled,
        needsEnablement: false
      };
    }

    if (!globalEnabled) {
      return {
        requestedMode,
        effectiveMode: 'queued',
        laneKey: '__global__',
        globalEnabled,
        needsEnablement: true
      };
    }

    if (providerSupportsParallel && providerAllowsParallel) {
      return {
        requestedMode,
        effectiveMode: 'parallel',
        laneKey: null,
        globalEnabled,
        needsEnablement: false
      };
    }

    return {
      requestedMode,
      effectiveMode: 'queued',
      laneKey: `provider:${provider || 'default'}`,
      globalEnabled,
      needsEnablement: false
    };
  }

  preemptBackgroundIfNeeded(mode, preemptible) {
    if (preemptible || mode !== 'chat') {
      return false;
    }
    if (typeof this.aiService.stopGeneration !== 'function') {
      return false;
    }

    const providersToStop = new Set();
    let requiresFallbackStop = false;
    for (const lock of this.activeLocks.values()) {
      if (!lock?.preemptible || lock.mode === 'chat') continue;
      if (lock.provider) {
        providersToStop.add(lock.provider);
      } else {
        requiresFallbackStop = true;
      }
    }

    if (providersToStop.size === 0 && !requiresFallbackStop) {
      return false;
    }

    try {
      let stopped = false;
      if (requiresFallbackStop) {
        stopped = this.aiService.stopGeneration() === true || stopped;
      }
      for (const provider of providersToStop) {
        stopped = this.aiService.stopGeneration(provider) === true || stopped;
      }
      return stopped;
    } catch (error) {
      return false;
    }
  }

  async executeScheduled(laneKey, work, lockContext = {}) {
    if (!laneKey) {
      return this.runWithLockContext(work, lockContext);
    }
    const previous = this.laneLocks.get(laneKey) || Promise.resolve();
    const queued = previous
      .catch(() => null)
      .then(() => this.runWithLockContext(work, lockContext));
    const lanePending = queued.finally(() => {
      if (this.laneLocks.get(laneKey) === lanePending) {
        this.laneLocks.delete(laneKey);
      }
    });
    this.laneLocks.set(laneKey, lanePending);
    return lanePending;
  }

  async runWithLockContext(work, { mode = null, preemptible = false, provider = null } = {}) {
    const lockId = Symbol('inference-lock');
    const normalizedProvider = String(provider || '').trim().toLowerCase() || null;
    this.activeLocks.set(lockId, {
      mode,
      preemptible: preemptible === true,
      provider: normalizedProvider
    });
    try {
      return await work();
    } finally {
      this.activeLocks.delete(lockId);
    }
  }
}

module.exports = { InferenceScheduler };