// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

function formatMs(value) {
  return `${Math.round(Number(value || 0))}ms`;
}

class StartupProfiler {
  constructor(options = {}) {
    const traceFile = String(options.traceFile || process.env.LOCALAGENT_STARTUP_TRACE_FILE || '').trim();
    this.enabled = options.enabled === true
      || process.env.LOCALAGENT_STARTUP_TRACE === '1'
      || Boolean(traceFile);
    this.logger = options.logger || console;
    this.startedAt = performance.now();
    this.lastAt = this.startedAt;
    this.events = [];
    this.traceFile = traceFile || null;
    this._traceWriteError = null;

    if (this.traceFile) {
      this._writeTraceFile();
    }
  }

  _buildTracePayload() {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      pid: process.pid,
      argv: process.argv.slice(),
      events: this.summary()
    };
  }

  _writeTraceFile() {
    if (!this.traceFile || this._traceWriteError) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.traceFile), { recursive: true });
      fs.writeFileSync(this.traceFile, JSON.stringify(this._buildTracePayload(), null, 2), 'utf-8');
    } catch (error) {
      this._traceWriteError = error;
      if (this.logger?.warn) {
        this.logger.warn(`[Startup] Failed to write trace file: ${error.message || String(error)}`);
      }
    }
  }

  mark(name, detail = null) {
    const now = performance.now();
    const event = {
      name: String(name || 'startup.mark'),
      elapsedMs: now - this.startedAt,
      deltaMs: now - this.lastAt,
      detail: detail && typeof detail === 'object' ? { ...detail } : detail
    };
    this.lastAt = now;
    this.events.push(event);

    if (this.enabled && this.logger?.log) {
      const suffix = event.detail ? ` ${JSON.stringify(event.detail)}` : '';
      this.logger.log(`[Startup] ${event.name} +${formatMs(event.deltaMs)} total=${formatMs(event.elapsedMs)}${suffix}`);
    }

    this._writeTraceFile();
    return event;
  }

  timeSync(name, fn) {
    const startedAt = performance.now();
    try {
      return fn();
    } finally {
      this.mark(name, { durationMs: performance.now() - startedAt });
    }
  }

  async time(name, fn) {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      this.mark(name, { durationMs: performance.now() - startedAt });
    }
  }

  summary() {
    return this.events.map(event => ({ ...event }));
  }
}

function createStartupProfiler(options = {}) {
  return new StartupProfiler(options);
}

module.exports = {
  StartupProfiler,
  createStartupProfiler
};
