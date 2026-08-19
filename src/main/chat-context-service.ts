// @ts-nocheck
const { getEffectiveLlmSelection } = require('./llm-state');
const {
  calculateConversationContextUsage,
  buildConversationContext,
  SessionConversationContextCache
} = require('./conversation-context');
const { isPrivateSessionId } = require('./private-session-store');

/*
 * SESSION CONTEXT SIZE INVARIANT
 *
 * `context_tokens` is the full session/request context returned by the provider.
 * It is not a per-turn delta. Never sum turns, add output tokens, accumulate usage,
 * clamp it to a high-water mark, or replace a known real value with a local estimate.
 *
 * A new real provider value replaces the previous real value exactly as returned.
 * If a successful response omits input/context usage, keep the last matching real
 * measurement unchanged. Local estimation is allowed only when this session has no
 * real measurement for the currently selected provider/model/context window.
 */
class ChatContextService {
  constructor(options = {}) {
    this.db = options.db;
    this.dispatcher = options.dispatcher || null;
    this.privateSessionStore = options.privateSessionStore || null;
    this.testClientMode = options.testClientMode === true;
    this.getTestMessages = typeof options.getTestMessages === 'function'
      ? options.getTestMessages
      : null;
    this.cache = options.cache || new SessionConversationContextCache({
      cleaners: options.cleaners || {}
    });
    this.logger = Object.prototype.hasOwnProperty.call(options, 'logger')
      ? options.logger
      : console;
    this.providerContextData = new Map();
  }

  _buildScopeOptions(options = {}) {
    const scope = options?.scopeOptions || options?.dbQueryOptions || options || {};
    const userId = String(scope?.userId || '').trim();
    return {
      requestContext: scope?.requestContext || null,
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

  async _saveSetting(key, value, options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    if (this.db?.saveScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.saveScopedSetting(key, value, scopeOptions);
    }
    return this.db.saveSetting(key, value);
  }

  async _deleteSetting(key, options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    if (this.db?.deleteScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.deleteScopedSetting(key, scopeOptions);
    }
    return this.db.deleteSetting ? this.db.deleteSetting(key) : null;
  }

  async loadAllHistory(sessionId = null, options = {}) {
    const dbQueryOptions = options?.dbQueryOptions || {};
    if (isPrivateSessionId(sessionId) && this.privateSessionStore) {
      return this.privateSessionStore.getMessages(sessionId, Number.MAX_SAFE_INTEGER);
    }

    if (
      this.testClientMode
      && this.getTestMessages
      && (this._isTestSessionId(sessionId) || !sessionId)
    ) {
      return this.getTestMessages(sessionId, Number.MAX_SAFE_INTEGER);
    }

    if (sessionId && typeof this.db?.loadChatSession === 'function') {
      return this.db.loadChatSession(sessionId, { includeHidden: true, ...dbQueryOptions });
    }

    return this.db.getConversations(Number.MAX_SAFE_INTEGER, sessionId, dbQueryOptions);
  }

  async resolveContextProfile(options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    let provider = options.provider;
    let model = options.model;
    if ((!provider || !model) && this.db) {
      const selection = await getEffectiveLlmSelection(this.db, scopeOptions);
      provider = provider || selection.provider;
      model = model || selection.model;
    }

    let contextWindow = options.contextWindow;
    if (this.dispatcher && typeof this.dispatcher.resolveContextWindow === 'function') {
      contextWindow = await this.dispatcher.resolveContextWindow({
        provider,
        model,
        modelSpec: options.modelSpec,
        runtimeConfig: options.runtimeConfig,
        ...scopeOptions
      });
    } else if (!contextWindow) {
      contextWindow = (await this._getSetting('context_window', scopeOptions)) || '8192';
    }

    return { provider: provider || null, model: model || null, contextWindow };
  }

  async resolveContextWindow(options = {}) {
    return (await this.resolveContextProfile(options)).contextWindow;
  }

  async buildContext(sessionId, currentPrompt = '', options = {}) {
    const contextWindow = await this.resolveContextWindow(options);
    const cachedHistory = await this.cache.getOrLoad(
      sessionId,
      () => this.loadAllHistory(sessionId, options)
    );
    const projectedHistory = await this._applyContextCheckpoint(sessionId, cachedHistory, options);
    const context = buildConversationContext(projectedHistory, {
      contextWindow,
      currentPrompt
    });
    this._logContext(sessionId, context);
    return context;
  }

  async buildPromptHistory(sessionId, currentPrompt = '', options = {}) {
    const context = await this.buildContext(sessionId, currentPrompt, options);
    return context.messages;
  }

  async getUsageEstimate(sessionId = null, currentPrompt = '', options = {}) {
    const promptText = String(currentPrompt || '');
    const profile = await this.resolveContextProfile(options);
    const providerCandidate = this.getActiveProviderContextUsage(sessionId)
      || await this.getProviderContextUsage(sessionId, options);
    const providerData = this._matchesContextProfile(providerCandidate, profile)
      ? providerCandidate
      : null;
    // Provider output is the source of the real session context size.
    // Use local calculation only when provider output has no real session context value.
    if (providerData) {
      return this._resolveDisplayedContextUsage(providerData, null, profile);
    }
    const cachedHistory = await this.cache.getOrLoad(
      sessionId,
      () => this.loadAllHistory(sessionId, options)
    );
    const projectedHistory = await this._applyContextCheckpoint(sessionId, cachedHistory, options);
    const usage = this.dispatcher?.estimateContextUsage
      ? await this.dispatcher.estimateContextUsage(promptText, projectedHistory, {
          ...options,
          sessionId,
          provider: profile.provider,
          model: profile.model
        })
      : calculateConversationContextUsage(projectedHistory, {
          contextWindow: profile.contextWindow,
          currentPrompt: promptText
        });
    return this._resolveDisplayedContextUsage(null, usage, profile);
  }

  _matchesContextProfile(providerData, profile = {}) {
    if (!providerData) return false;
    const expectedProvider = String(profile.provider || '').trim().toLowerCase();
    const measuredProvider = String(providerData.provider || '').trim().toLowerCase();
    if (expectedProvider && measuredProvider !== expectedProvider) return false;
    const expectedModel = String(profile.model || '').trim();
    const measuredModel = String(providerData.model || '').trim();
    if (expectedModel && measuredModel !== expectedModel) return false;
    const expectedContext = Number(profile.contextWindow || 0);
    const measuredContext = Number(providerData.context_length || providerData.contextLength || 0);
    if (expectedContext > 0 && measuredContext > 0 && expectedContext !== measuredContext) return false;
    return true;
  }

  _resolveDisplayedContextUsage(providerData, localUsage, profile = {}) {
    const providerContextTokens = Number(providerData?.context_tokens ?? providerData?.tokens ?? 0);
    const providerInput = Number(providerData?.input_tokens ?? providerData?.prompt_tokens ?? 0);
    const providerOutput = Number(providerData?.output_tokens ?? providerData?.completion_tokens ?? 0);
    const providerTotal = Number(providerData?.total_tokens || (providerInput + providerOutput));
    const hasProviderContext = Boolean(providerData)
      && Number.isFinite(providerContextTokens)
      && providerContextTokens > 0;
    if (hasProviderContext) {
      const contextLength = Number(providerData?.context_length || providerData?.contextLength || profile.contextWindow || 0);
      return {
        ...providerData,
        tokens: providerContextTokens,
        context_tokens: providerContextTokens,
        input_tokens: providerInput,
        prompt_tokens: providerInput,
        output_tokens: providerOutput,
        completion_tokens: providerOutput,
        total_tokens: providerTotal,
        provider_tokens: providerContextTokens,
        local_tokens: null,
        source: providerData.source || 'provider',
        estimated: false,
        provider: providerData?.provider || profile.provider || null,
        model: providerData?.model || profile.model || null,
        context_length: contextLength,
        contextLength,
        total_messages: null,
        overflow: contextLength > 0 && providerContextTokens > contextLength,
        truncated_for_send: false,
        truncated: false
      };
    }
    const localTokens = Number(localUsage?.tokens || 0);
    const contextLength = Number(localUsage?.contextWindow || profile.contextWindow || providerData?.context_length || providerData?.contextLength || 0);
    return {
      tokens: localTokens,
      context_tokens: localTokens,
      input_tokens: localTokens,
      prompt_tokens: localTokens,
      output_tokens: 0,
      completion_tokens: 0,
      total_tokens: localTokens,
      provider_tokens: null,
      local_tokens: localTokens,
      source: 'local',
      estimated: true,
      provider: profile.provider || null,
      model: profile.model || null,
      context_length: contextLength,
      contextLength,
      total_messages: localUsage?.totalMessages ?? null,
      overflow: contextLength > 0 && localTokens > contextLength,
      truncated_for_send: false,
      truncated: false
    };
  }

  _providerUsageSettingKey(sessionId) {
    const sid = String(sessionId || '').trim();
    return sid ? `session.contextUsage.${sid}` : null;
  }

  normalizeProviderContextUsage(response = {}) {
    // This maps one provider response containing the full session context. Never
    // reinterpret its input count as a turn delta or combine it with earlier turns.
    const usage = response?.usage || {};
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
    const totalTokens = Number(usage.total_tokens || (inputTokens + outputTokens));
    const responseProvider = String(response.renderContext?.provider || '').trim().toLowerCase();
    const configuredContextLength = responseProvider === 'openrouter'
      ? 0
      : response.renderContext?.runtimeConfig?.contextWindow?.value;
    const contextLength = Number(response.context_length || usage.contextLength || configuredContextLength || 0);
    const isEstimated = usage.estimated === true;
    const hasProviderInput = Number.isFinite(inputTokens) && inputTokens > 0;
    if (isEstimated || !hasProviderInput) return null;
    const explicitContextTokens = Number(
      response.context_tokens
      ?? response.contextTokens
      ?? usage.context_tokens
      ?? usage.contextTokens
      ?? 0
    );
    const contextTokens = Number.isFinite(explicitContextTokens) && explicitContextTokens > 0
      ? explicitContextTokens
      : inputTokens;
    return {
      tokens: contextTokens,
      context_tokens: contextTokens,
      input_tokens: inputTokens,
      prompt_tokens: inputTokens,
      output_tokens: outputTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
      cached_tokens: Number(usage.cached_tokens || 0),
      context_length: contextLength,
      contextLength,
      estimated: isEstimated,
      provider: response.renderContext?.provider || null,
      model: response.renderContext?.model || response.model || null,
      source: 'provider',
      updated_at: new Date().toISOString()
    };
  }

  async saveProviderContextUsage(sessionId, response = {}, options = {}) {
    const key = this._providerUsageSettingKey(sessionId);
    if (!key) return null;
    const providerData = this.normalizeProviderContextUsage(response);
    // Missing input usage is not a zero-sized context and does not invalidate the last
    // real measurement. Deleting it here recreates the estimate jump/drop regression.
    if (!providerData) return null;
    this.providerContextData.set(key, providerData);
    if (isPrivateSessionId(sessionId)) return providerData;
    const mergedOptions = {
      ...this._buildScopeOptions(options),
      requestContext: options?.requestContext || response?.renderContext?.requestContext || null
    };
    await this._saveSetting(key, JSON.stringify(providerData), mergedOptions);
    return providerData;
  }

  getActiveProviderContextUsage(sessionId) {
    const key = this._providerUsageSettingKey(sessionId);
    return key ? this.providerContextData.get(key) || null : null;
  }

  async getProviderContextUsage(sessionId, options = {}) {
    const key = this._providerUsageSettingKey(sessionId);
    if (!key || !this.db?.getSetting) return null;
    try {
      const raw = await this._getSetting(key, options);
      return this._normalizeStoredContextUsage(raw ? JSON.parse(raw) : null);
    } catch (_) {
      return null;
    }
  }

  _normalizeStoredContextUsage(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.estimated === true) return null;
    const inputTokens = Number(value.input_tokens ?? value.prompt_tokens ?? 0);
    const outputTokens = Number(value.output_tokens ?? value.completion_tokens ?? 0);
    const totalTokens = Number(value.total_tokens || (inputTokens + outputTokens));
    const explicitContextTokens = Number(value.context_tokens ?? value.contextTokens ?? value.tokens ?? 0);
    const contextTokens = Number.isFinite(explicitContextTokens) && explicitContextTokens > 0
      ? explicitContextTokens
      : inputTokens;
    const contextLength = Number(value.context_length || value.contextLength || 0);
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return null;
    return {
      ...value,
      tokens: contextTokens,
      context_tokens: contextTokens,
      input_tokens: inputTokens,
      prompt_tokens: inputTokens,
      output_tokens: outputTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
      context_length: contextLength,
      contextLength,
      source: 'saved',
      overflow: contextLength > 0 && contextTokens > contextLength,
      truncated_for_send: false
    };
  }

  async clearProviderContextUsage(sessionId = null, options = {}) {
    const key = this._providerUsageSettingKey(sessionId);
    if (key) {
      this.providerContextData.delete(key);
      return this._deleteSetting(key, options);
    }
    this.providerContextData.clear();
    if (this.db?.run) this.db.run("DELETE FROM settings WHERE key LIKE 'session.contextUsage.%'");
    return null;
  }

  _contextCheckpointSettingKey(sessionId) {
    const sid = String(sessionId || '').trim();
    return sid ? `session.contextCheckpoint.${sid}` : null;
  }

  async getContextCheckpoint(sessionId, options = {}) {
    const key = this._contextCheckpointSettingKey(sessionId);
    if (!key) return null;
    try {
      const raw = await this._getSetting(key, options);
      if (!raw) return null;
      const checkpoint = JSON.parse(raw);
      return checkpoint && typeof checkpoint === 'object' ? checkpoint : null;
    } catch (_) {
      return null;
    }
  }

  async saveContextCheckpoint(sessionId, checkpoint = {}, options = {}) {
    const key = this._contextCheckpointSettingKey(sessionId);
    if (!key) throw new Error('sessionId is required for a context checkpoint');
    const normalized = {
      version: 1,
      mode: checkpoint.mode === 'native' ? 'native' : 'local',
      provider: String(checkpoint.provider || '').trim() || null,
      summary: String(checkpoint.summary || '').trim(),
      cutoffMessageCount: Math.max(0, Number(checkpoint.cutoffMessageCount || 0)),
      externalSessionId: String(checkpoint.externalSessionId || '').trim() || null,
      createdAt: checkpoint.createdAt || new Date().toISOString()
    };
    await this._saveSetting(key, JSON.stringify(normalized), options);
    return normalized;
  }

  async clearContextCheckpoint(sessionId, options = {}) {
    const key = this._contextCheckpointSettingKey(sessionId);
    if (!key) return null;
    return this._deleteSetting(key, options);
  }

  async _applyContextCheckpoint(sessionId, history = [], options = {}) {
    const checkpoint = await this.getContextCheckpoint(sessionId, options);
    if (!checkpoint || !['local', 'native'].includes(checkpoint.mode) || !String(checkpoint.summary || '').trim()) {
      return history;
    }
    const cutoff = Math.min(history.length, Math.max(0, Number(checkpoint.cutoffMessageCount || 0)));
    return [
      {
        role: 'system',
        content: [
          'Conversation continuation checkpoint:',
          String(checkpoint.summary || '').trim(),
          'Continue naturally from this checkpoint and the newer messages below.'
        ].join('\n\n')
      },
      ...history.slice(cutoff)
    ];
  }

  append(sessionId, message) {
    this.cache.append(sessionId, message);
  }

  invalidate(sessionId = null) {
    this.cache.invalidate(sessionId);
  }

  _isTestSessionId(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('testclient-');
  }

  _logContext(sessionId, context) {
    if (!this.logger?.log) return;
    this.logger.log(
      `[Context] session=${sessionId || 'current'} included=${context.includedMessages}/${context.totalMessages} ` +
      `estimated=${context.estimatedTokens}/${context.availableHistoryTokens} historyTokens window=${context.contextWindow}`
    );
  }
}

function createChatContextService(options = {}) {
  return new ChatContextService(options);
}

module.exports = {
  ChatContextService,
  createChatContextService
};
