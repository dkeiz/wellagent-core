// @ts-nocheck
const crypto = require('crypto');

const TERMINAL_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);

function normalizeRequestId(value = '') {
  const candidate = String(value || '').trim();
  return candidate || `turn-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

class LiveTurn {
  constructor(options = {}) {
    this.windowManager = options.windowManager || null;
    this.requestId = normalizeRequestId(options.requestId);
    this.sessionId = options.sessionId || null;
    this.agentId = options.agentId || null;
    this.provider = String(options.provider || '').trim() || null;
    this.model = String(options.model || '').trim() || null;
    this.sequence = 0;
    this.terminal = false;
  }

  emit(event = {}) {
    const type = String(event.type || '').trim();
    if (!type || this.terminal) return null;
    const payload = {
      ...event,
      type,
      requestId: this.requestId,
      sessionId: event.sessionId || this.sessionId,
      agentId: event.agentId ?? this.agentId,
      provider: event.provider || this.provider,
      model: event.model || this.model,
      sequence: ++this.sequence,
      timestamp: event.timestamp || new Date().toISOString()
    };
    this.windowManager?.send?.('chat-turn-event', payload);
    if (TERMINAL_TYPES.has(type)) this.terminal = true;
    return payload;
  }

  sink() {
    return {
      requestId: this.requestId,
      sessionId: this.sessionId,
      emit: (event) => this.emit(event)
    };
  }
}

module.exports = { LiveTurn, normalizeRequestId };
