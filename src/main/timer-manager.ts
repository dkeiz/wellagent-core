// @ts-nocheck
const DEFAULT_TIMER_MESSAGE = 'A scheduled timer fired. Continue from this timer event and perform the requested follow-up.';
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_TIMERS_PER_CONTEXT = 50;

function safeJsonParse(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function normalizeUnit(unit) {
  const raw = String(unit || 'seconds').trim().toLowerCase();
  if (raw === 'millisecond' || raw === 'milliseconds') return 'ms';
  if (raw === 'second') return 'seconds';
  if (raw === 'minute') return 'minutes';
  if (raw === 'hour') return 'hours';
  return raw;
}

function delayToMs(delay, unit) {
  const amount = Number(delay);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('delay must be a positive number');
  }
  const normalized = normalizeUnit(unit);
  const multipliers = { ms: 1, seconds: 1000, minutes: 60 * 1000, hours: 60 * 60 * 1000 };
  if (!multipliers[normalized]) {
    throw new Error('unit must be one of: ms, seconds, minutes, hours');
  }
  const delayMs = Math.round(amount * multipliers[normalized]);
  if (delayMs < MIN_DELAY_MS) {
    throw new Error(`delay must be at least ${MIN_DELAY_MS}ms`);
  }
  if (delayMs > MAX_DELAY_MS) {
    throw new Error(`delay must be at most ${MAX_DELAY_MS}ms`);
  }
  return delayMs;
}

function normalizeTimerId(value) {
  const id = String(value || '').trim();
  if (!id) return `timer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalized = id.replace(/[^a-zA-Z0-9_.:-]/g, '-').slice(0, 80);
  if (!normalized) throw new Error('id contains no usable characters');
  return normalized;
}

function requireTimerId(value) {
  const id = String(value || '').trim();
  if (!id) throw new Error('id is required for this timer action');
  return normalizeTimerId(id);
}

function contextValue(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function buildTimerContext(rawContext = {}) {
  const requestContext = rawContext?.requestContext && typeof rawContext.requestContext === 'object'
    ? rawContext.requestContext
    : null;
  const context = {
    source: contextValue(rawContext.source || requestContext?.source) || 'unknown',
    sessionId: contextValue(rawContext.sessionId),
    agentId: contextValue(rawContext.agentId),
    workflowId: contextValue(rawContext.workflowId),
    workflowRunId: contextValue(rawContext.workflowRunId),
    subagentRunId: contextValue(rawContext.subagentRunId),
    userId: contextValue(rawContext.userId || requestContext?.userId),
    requestContext: requestContext || null
  };
  const parts = [
    ['user', context.userId],
    ['session', context.sessionId],
    ['agent', context.agentId],
    ['workflow', context.workflowId],
    ['workflowRun', context.workflowRunId],
    ['subagentRun', context.subagentRunId],
    ['source', context.source]
  ].filter(([, value]) => value);
  context.contextKey = parts.length
    ? parts.map(([key, value]) => `${key}:${value}`).join('|')
    : 'global';
  return context;
}

function mapTimerRow(row, now = Date.now()) {
  const dueMs = row?.due_at ? new Date(row.due_at).getTime() : null;
  const remainingMs = row?.status === 'paused'
    ? Number(row.remaining_ms || 0)
    : (dueMs ? Math.max(0, dueMs - now) : null);
  return {
    id: row.timer_id,
    status: row.status,
    dueAt: row.due_at || null,
    remainingMs,
    repeat: row.repeat === 1 || row.repeat === true,
    intervalMs: Number(row.interval_ms || 0),
    message: row.message || '',
    context: safeJsonParse(row.context_json, {})
  };
}

class TimerManager {
  constructor({ db, dispatcher, windowManager = null, pollMs = 1000, chatContextService = null }) {
    this.db = db;
    this.dispatcher = dispatcher;
    this.chainController = null;
    this.chatContextService = chatContextService;
    this.windowManager = windowManager;
    this.pollMs = Math.max(250, Number(pollMs) || 1000);
    this._pollHandle = null;
    this._running = false;
  }

  initialize() {
    this.stop();
    this._pollHandle = setInterval(() => {
      this.fireDueTimers().catch(error => {
        console.error('[TimerManager] Failed to process due timers:', error.message);
      });
    }, this.pollMs);
    if (this._pollHandle.unref) this._pollHandle.unref();
    this.fireDueTimers().catch(error => {
      console.error('[TimerManager] Startup timer check failed:', error.message);
    });
  }

  stop() {
    if (this._pollHandle) clearInterval(this._pollHandle);
    this._pollHandle = null;
  }

  setChainController(chainController) {
    this.chainController = chainController || null;
  }

  setChatContextService(chatContextService) {
    this.chatContextService = chatContextService || null;
  }

  async handle(params = {}, execution = {}) {
    const action = String(params.action || '').trim().toLowerCase();
    if (action === 'set') return this.setTimer(params, execution.context || {});
    if (action === 'list') return this.listTimers(execution.context || {});
    if (action === 'off') return this.offTimer(params, execution.context || {});
    if (action === 'pause') return this.pauseTimer(params, execution.context || {});
    if (action === 'resume') return this.resumeTimer(params, execution.context || {});
    throw new Error('action must be one of: set, list, off, pause, resume');
  }

  async setTimer(params, rawContext) {
    const context = buildTimerContext(rawContext);
    const delayMs = delayToMs(params.delay, params.unit);
    const timerId = normalizeTimerId(params.id);
    const active = await this.db.listScheduledTimers(context.contextKey);
    const existing = await this.db.getScheduledTimer(timerId, context.contextKey);
    if (!existing && active.length >= MAX_ACTIVE_TIMERS_PER_CONTEXT) {
      throw new Error(`Timer limit reached for this context (${MAX_ACTIVE_TIMERS_PER_CONTEXT})`);
    }
    const now = Date.now();
    const dueAt = new Date(now + delayMs).toISOString();
    const row = await this.db.upsertScheduledTimer({
      timer_id: timerId,
      context_key: context.contextKey,
      context,
      status: 'active',
      due_at: dueAt,
      interval_ms: delayMs,
      remaining_ms: null,
      repeat: params.repeat === true,
      message: String(params.message || ''),
      paused_at: null,
      fired_at: null,
      last_error: null
    });
    return { ok: true, ...mapTimerRow(row, now) };
  }

  async listTimers(rawContext) {
    const context = buildTimerContext(rawContext);
    const rows = await this.db.listScheduledTimers(context.contextKey);
    return { ok: true, context: context.contextKey, timers: rows.map(row => mapTimerRow(row)) };
  }

  async offTimer(params, rawContext) {
    const context = buildTimerContext(rawContext);
    const timerId = requireTimerId(params.id);
    const row = await this.db.getScheduledTimer(timerId, context.contextKey);
    if (!row) return { ok: false, id: timerId, error: 'Timer not found in this context' };
    await this.db.updateScheduledTimerState(timerId, context.contextKey, {
      status: 'cancelled',
      due_at: null,
      remaining_ms: null
    });
    return { ok: true, id: timerId, status: 'cancelled' };
  }

  async pauseTimer(params, rawContext) {
    const context = buildTimerContext(rawContext);
    const timerId = requireTimerId(params.id);
    const row = await this.db.getScheduledTimer(timerId, context.contextKey);
    if (!row) return { ok: false, id: timerId, error: 'Timer not found in this context' };
    if (row.status !== 'active') return { ok: false, id: timerId, error: `Timer is ${row.status}` };
    const remainingMs = Math.max(0, new Date(row.due_at).getTime() - Date.now());
    const updated = await this.db.updateScheduledTimerState(timerId, context.contextKey, {
      status: 'paused',
      due_at: null,
      remaining_ms: remainingMs,
      paused_at: new Date().toISOString()
    });
    return { ok: true, ...mapTimerRow(updated) };
  }

  async resumeTimer(params, rawContext) {
    const context = buildTimerContext(rawContext);
    const timerId = requireTimerId(params.id);
    const row = await this.db.getScheduledTimer(timerId, context.contextKey);
    if (!row) return { ok: false, id: timerId, error: 'Timer not found in this context' };
    if (row.status !== 'paused') return { ok: false, id: timerId, error: `Timer is ${row.status}` };
    const remainingMs = Math.max(MIN_DELAY_MS, Number(row.remaining_ms || row.interval_ms || MIN_DELAY_MS));
    const dueAt = new Date(Date.now() + remainingMs).toISOString();
    const updated = await this.db.updateScheduledTimerState(timerId, context.contextKey, {
      status: 'active',
      due_at: dueAt,
      remaining_ms: null,
      paused_at: null
    });
    return { ok: true, ...mapTimerRow(updated) };
  }

  async fireDueTimers(now = new Date()) {
    if (this._running) return { ok: true, skipped: true };
    this._running = true;
    try {
      const dueRows = await this.db.getDueScheduledTimers(now.toISOString());
      for (const row of dueRows) {
        await this._fireTimer(row, now);
      }
      return { ok: true, fired: dueRows.length };
    } finally {
      this._running = false;
    }
  }

  async _fireTimer(row, now) {
    const context = safeJsonParse(row.context_json, {});
    const scheduledFor = row.due_at;
    const firedAt = now.toISOString();
    const missedByMs = Math.max(0, now.getTime() - new Date(scheduledFor).getTime());
    const event = {
      type: 'timer_fired',
      timerId: row.timer_id,
      message: row.message || DEFAULT_TIMER_MESSAGE,
      scheduledFor,
      firedAt,
      missedByMs
    };
    try {
      if (context.sessionId) {
        await this._invokeChatContext(context, event);
      } else {
        await this._invokeInternalContext(context, event);
      }
      if (row.repeat === 1 || row.repeat === true) {
        await this.db.updateScheduledTimerState(row.timer_id, row.context_key, {
          status: 'active',
          due_at: new Date(now.getTime() + Number(row.interval_ms || MIN_DELAY_MS)).toISOString(),
          fired_at: firedAt,
          last_error: null
        });
      } else {
        await this.db.updateScheduledTimerState(row.timer_id, row.context_key, {
          status: 'fired',
          due_at: null,
          fired_at: firedAt,
          last_error: null
        });
      }
    } catch (error) {
      await this.db.updateScheduledTimerState(row.timer_id, row.context_key, {
        status: 'active',
        last_error: error.message
      });
      throw error;
    }
  }

  async _invokeChatContext(context, event) {
    const content = this._formatTimerEvent(event);
    const dbQueryOptions = context.requestContext ? { requestContext: context.requestContext } : {};
    const systemEntry = {
      role: 'system',
      content,
      metadata: { source: 'timer', timerId: event.timerId }
    };
    await this.db.addConversation(systemEntry, context.sessionId, dbQueryOptions);
    if (this.chatContextService?.append) this.chatContextService.append(context.sessionId, systemEntry);
    const history = this.chatContextService?.buildPromptHistory
      ? await this.chatContextService.buildPromptHistory(context.sessionId, content, { dbQueryOptions })
      : (typeof this.db.loadChatSession === 'function'
        ? await this.db.loadChatSession(context.sessionId, { includeHidden: true, ...dbQueryOptions })
        : await this.db.getConversations(Number.MAX_SAFE_INTEGER, context.sessionId, dbQueryOptions))
        .map(message => ({ role: message.role, content: message.content }))
        .filter(message => message.content);
    const options = {
      mode: 'chat',
      sessionId: context.sessionId,
      agentId: context.agentId || null,
      preemptible: true,
      requestContext: context.requestContext || null
    };
    const response = this.chainController?.executeWithChaining
      ? await this.chainController.executeWithChaining(content, history, options)
      : await this.dispatcher.dispatch(content, history, options);
    if (response?.content) {
      const assistantEntry = { role: 'assistant', content: response.content };
      await this.db.addConversation(assistantEntry, context.sessionId, dbQueryOptions);
      if (this.chatContextService?.append) this.chatContextService.append(context.sessionId, assistantEntry);
      if (this.chatContextService?.saveProviderContextUsage) {
        await this.chatContextService.saveProviderContextUsage(context.sessionId, response);
      }
    }
    this.windowManager?.send?.('conversation-update', { sessionId: context.sessionId, source: 'timer' });
  }

  async _invokeInternalContext(context, event) {
    await this.dispatcher.dispatch(this._formatTimerEvent(event), [], {
      mode: 'internal',
      includeTools: false,
      includeRules: false,
      includeEnv: true,
      agentId: context.agentId || null,
      preemptible: true,
      requestContext: context.requestContext || null
    });
  }

  _formatTimerEvent(event) {
    return [
      'A scheduled timer fired.',
      `Timer id: ${event.timerId}`,
      `Scheduled for: ${event.scheduledFor}`,
      `Fired at: ${event.firedAt}`,
      event.missedByMs ? `Missed by: ${event.missedByMs}ms` : 'Missed by: 0ms',
      `Instruction: ${event.message || DEFAULT_TIMER_MESSAGE}`
    ].join('\n');
  }
}

module.exports = { TimerManager };
