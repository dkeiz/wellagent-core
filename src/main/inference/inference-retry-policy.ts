// @ts-nocheck
const crypto = require('crypto');

class RetryCancelledError extends Error {
  constructor() {
    super('Generation stopped');
    this.name = 'RetryCancelledError';
    this.code = 'INFERENCE_RETRY_CANCELLED';
  }
}

class InferenceRetryPolicy {
  constructor({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.active = new Map();
  }

  async run(work, options = {}) {
    const entry = {
      id: crypto.randomUUID(),
      provider: String(options.provider || '').trim().toLowerCase(),
      sessionId: options.sessionId || null,
      onStatus: typeof options.onRetryStatus === 'function' ? options.onRetryStatus : null,
      cancelled: false,
      wait: null,
      statusTimer: null,
      failures: 0
    };
    this.active.set(entry.id, entry);
    try {
      while (true) {
        this._throwIfCancelled(entry);
        try {
          const result = await work();
          if (entry.failures > 0) this._clearStatus(entry);
          return result;
        } catch (error) {
          this._throwIfCancelled(entry);
          if (!this._shouldRetry(error, options)) throw error;
          entry.failures += 1;
          if (entry.failures === 1) continue;
          if (entry.failures === 2) {
            await this._delay(entry, 10000, 'Retrying generation in 10 seconds…');
            continue;
          }
          if (entry.failures === 3) {
            await this._delay(entry, 30000, 'Retrying generation in 30 seconds…');
            continue;
          }
          await this._pause(entry, error);
        }
      }
    } finally {
      this._clearTimer(entry);
      this.active.delete(entry.id);
    }
  }

  confirm(requestId) {
    const entry = this.active.get(String(requestId || ''));
    if (!entry?.wait || entry.wait.kind !== 'pause') return false;
    entry.wait.resolve();
    return true;
  }

  cancel(provider = null) {
    const target = String(provider || '').trim().toLowerCase();
    let cancelled = false;
    for (const entry of this.active.values()) {
      if (target && entry.provider !== target) continue;
      entry.cancelled = true;
      this._clearStatus(entry);
      entry.wait?.reject(new RetryCancelledError());
      cancelled = true;
    }
    return cancelled;
  }

  _delay(entry, delayMs, message) {
    this._emitStatus(entry, { state: 'waiting', delayMs, message });
    return this._wait(entry, 'delay', delayMs);
  }

  _pause(entry, error) {
    this._emitStatus(entry, {
      state: 'paused',
      message: 'Generation failed again. Confirm to retry.',
      error: String(error?.message || error || 'Unknown inference error')
    });
    return this._wait(entry, 'pause');
  }

  _wait(entry, kind, delayMs = null) {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        if (entry.wait?.timer) this.clearTimer(entry.wait.timer);
        entry.wait = null;
        fn(value);
      };
      entry.wait = {
        kind,
        resolve: () => finish(resolve),
        reject: (error) => finish(reject, error),
        timer: delayMs === null ? null : this.setTimer(() => finish(resolve), delayMs)
      };
    });
  }

  _emitStatus(entry, status) {
    this._clearTimer(entry);
    entry.onStatus?.({ requestId: entry.id, sessionId: entry.sessionId, failureCount: entry.failures, ...status });
    entry.statusTimer = this.setTimer(() => {
      entry.statusTimer = null;
      entry.onStatus?.({ requestId: entry.id, sessionId: entry.sessionId, state: 'clear' });
      if (status.state === 'paused') {
        entry.cancelled = true;
        entry.wait?.reject(new RetryCancelledError());
      }
    }, 60000);
  }

  _clearStatus(entry) {
    this._clearTimer(entry);
    entry.onStatus?.({ requestId: entry.id, sessionId: entry.sessionId, state: 'clear' });
  }

  _clearTimer(entry) {
    if (!entry.statusTimer) return;
    this.clearTimer(entry.statusTimer);
    entry.statusTimer = null;
  }

  _throwIfCancelled(entry) {
    if (entry.cancelled) throw new RetryCancelledError();
  }

  _shouldRetry(error, options = {}) {
    if (typeof options.shouldRetry === 'function') return options.shouldRetry(error) !== false;
    let current = error;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
      const status = Number(current.status || current.response?.status || 0);
      if (status >= 400 && status < 500) {
        return [408, 409, 425, 429].includes(status);
      }
      if (['INVALID_URL', 'UNSUPPORTED_PROTOCOL'].includes(current.code)) return false;
    }
    return true;
  }
}

module.exports = { InferenceRetryPolicy, RetryCancelledError };
