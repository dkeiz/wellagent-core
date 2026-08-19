// @ts-nocheck
const { stripToolPatterns, stripReasoningBlocks, buildAssistantContent } = require('./ipc/shared-utils');
const { getModelRuntimeConfig, saveModelRuntimeConfig } = require('./llm-config');
const {
  getEffectiveLlmSelection,
  rememberLastWorkingModel,
  rememberTestedModel,
  saveActiveSelection
} = require('./llm-state');
const { saveActiveModelContext } = require('./model-context-settings');
const requestContextHelpers = require('./request-context');

const SESSION_MAP_KEY = 'external.channelSessionMap';

function normalizeChannel(channel) {
  return String(channel || 'external').trim().toLowerCase() || 'external';
}

function normalizeChatId(chatId) {
  return String(chatId || '').trim();
}

function normalizeRequestContext(input = null) {
  if (requestContextHelpers?.normalizeRequestContext) {
    return requestContextHelpers.normalizeRequestContext(input || {});
  }
  return input || {};
}

function buildRequestScopeKey(requestContext = null) {
  const context = normalizeRequestContext(requestContext);
  const principal = String(context.userId || context.deviceId || 'default').trim() || 'default';
  return String(context.source || 'unknown').trim().toLowerCase() + '::' + principal;
}

function buildDbQueryOptions(requestContext = null) {
  const context = normalizeRequestContext(requestContext);
  return {
    requestContext: context,
    userId: context.userId || null
  };
}

function safeJsonParse(rawValue, fallback = {}) {
  if (!rawValue) return { ...fallback };
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...fallback };
    }
    return parsed;
  } catch (_) {
    return { ...fallback };
  }
}

class ExternalChannelBridge {
  constructor({
    db,
    dispatcher,
    chainController = null,
    windowManager = null,
    aiService = null,
    chatContextService = null,
    sessionCompactionService = null
  }) {
    this.db = db;
    this.dispatcher = dispatcher;
    this.chainController = chainController;
    this.windowManager = windowManager;
    this.aiService = aiService;
    this.chatContextService = chatContextService;
    this.sessionCompactionService = sessionCompactionService;
  }

  async _getRuntimeForResponse(response) {
    const responseRuntime = response?.renderContext?.runtimeConfig;
    if (responseRuntime && typeof responseRuntime === 'object') {
      return responseRuntime;
    }

    const provider = response?.renderContext?.provider;
    const model = response?.renderContext?.model;
    if (provider && model) {
      const { runtime } = await getModelRuntimeConfig(this.db, provider, model, buildDbQueryOptions(response?.renderContext?.requestContext || null));
      return runtime;
    }

    const responseRequestContext = response?.renderContext?.requestContext || null;
    const selection = await getEffectiveLlmSelection(this.db, buildDbQueryOptions(responseRequestContext));
    if (selection.provider && selection.model) {
      const { runtime } = await getModelRuntimeConfig(this.db, selection.provider, selection.model, buildDbQueryOptions(response?.renderContext?.requestContext || null));
      return runtime;
    }

    return null;
  }

  _notifyConversationUpdate(sessionId) {
    if (!this.windowManager?.send) return;
    this.windowManager.send('conversation-update', { sessionId });
  }

  async _loadSessionMap() {
    const raw = await this.db.getSetting(SESSION_MAP_KEY);
    return safeJsonParse(raw, {});
  }

  async _saveSessionMap(map) {
    await this.db.saveSetting(SESSION_MAP_KEY, JSON.stringify(map || {}));
  }

  _buildSessionMapKey(channel, chatId, requestContext = null) {
    return `${normalizeChannel(channel)}::${buildRequestScopeKey(requestContext)}::${normalizeChatId(chatId)}`;
  }

  async _setMappedSession(channel, chatId, sessionId, requestContext = null) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return null;
    const map = await this._loadSessionMap();
    map[this._buildSessionMapKey(channel, normalizedChatId, requestContext)] = String(sessionId);
    await this._saveSessionMap(map);
    return String(sessionId);
  }

  async _getMappedSession(channel, chatId, requestContext = null) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return null;
    const map = await this._loadSessionMap();
    const mapped = map[this._buildSessionMapKey(channel, normalizedChatId, requestContext)];
    return mapped ? String(mapped) : null;
  }

  async _clearMappedSession(channel, chatId, requestContext = null) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return false;
    const map = await this._loadSessionMap();
    const key = this._buildSessionMapKey(channel, normalizedChatId, requestContext);
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      return false;
    }
    delete map[key];
    await this._saveSessionMap(map);
    return true;
  }

  async _resolveExistingSession(sessionId, requestContext = null) {
    const explicit = String(sessionId || '').trim();
    if (!explicit) return null;
    if (typeof this.db.getChatSessionById === 'function') {
      return this.db.getChatSessionById(explicit, buildDbQueryOptions(requestContext));
    }
    return { id: explicit };
  }

  async resolveSession({ channel = 'external', chatId = '', sessionId = null, requestContext = null }) {
    const dbQueryOptions = buildDbQueryOptions(requestContext);
    const explicit = String(sessionId || '').trim();
    if (explicit) {
      const session = await this._resolveExistingSession(explicit, requestContext);
      return session?.id ? String(session.id) : null;
    }

    const mapped = await this._getMappedSession(channel, chatId, requestContext);
    if (mapped) {
      const session = await this._resolveExistingSession(mapped, requestContext);
      if (session?.id) {
        return String(session.id);
      }
      await this._clearMappedSession(channel, chatId, requestContext);
    }

    const current = await this.db.getCurrentSession(dbQueryOptions);
    const resolved = String(current?.id || '');
    if (!resolved) {
      const created = await this.db.createChatSession(null, dbQueryOptions);
      const createdId = String(created?.id || '');
      if (createdId) {
        await this._setMappedSession(channel, chatId, createdId, requestContext);
      }
      return createdId;
    }

    await this._setMappedSession(channel, chatId, resolved, requestContext);
    return resolved;
  }

  _buildMessageMetadata(channelMeta = {}, hiddenFromUi = false, extra = {}) {
    return {
      external_channel: {
        channel: normalizeChannel(channelMeta.channel || 'external'),
        chat_id: normalizeChatId(channelMeta.chatId),
        message_id: channelMeta.messageId || null,
        username: channelMeta.username || '',
        content_type: channelMeta.contentType || 'text'
      },
      hidden_from_ui: hiddenFromUi === true,
      ...extra
    };
  }

  async appendMessage({
    sessionId,
    role,
    content,
    hidden = false, channelMeta = {}, metadata = {},
    requestContext = null
  }) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      throw new Error('sessionId is required');
    }

    const entry = {
      role: String(role || 'system'),
      content: String(content || ''),
      metadata: this._buildMessageMetadata(channelMeta, hidden === true, metadata)
    };
    await this.db.addConversation(entry, normalizedSessionId, buildDbQueryOptions(requestContext));
    if (this.chatContextService?.append) this.chatContextService.append(normalizedSessionId, entry);

    this._notifyConversationUpdate(normalizedSessionId);
    return { success: true, sessionId: normalizedSessionId };
  }

  async requestReply({
    text,
    sessionId = null,
    duplicate = true, channelMeta = {},
    requestContext = null
  }) {
    const messageText = String(text || '').trim();
    if (!messageText) {
      return { success: false, error: 'text is required' };
    }

    const dbQueryOptions = buildDbQueryOptions(requestContext);
    const resolvedSessionId = await this.resolveSession({
      channel: channelMeta.channel || 'external',
      chatId: channelMeta.chatId || '',
      sessionId,
      requestContext
    });
    if (!resolvedSessionId) {
      return { success: false, error: 'Unable to resolve session' };
    }

    if (messageText.toLowerCase() === '/compact') {
      if (!this.sessionCompactionService?.compactSession) {
        return { success: false, error: 'Session compaction service is unavailable', sessionId: resolvedSessionId };
      }
      return this.sessionCompactionService.compactSession(resolvedSessionId, dbQueryOptions);
    }

    const hidden = duplicate !== true;
    const history = this.chatContextService?.buildPromptHistory
      ? await this.chatContextService.buildPromptHistory(resolvedSessionId, messageText, { dbQueryOptions })
      : (typeof this.db.loadChatSession === 'function'
        ? await this.db.loadChatSession(resolvedSessionId, { includeHidden: true, ...dbQueryOptions })
        : await this.db.getConversations(Number.MAX_SAFE_INTEGER, resolvedSessionId, dbQueryOptions))
        .map((conversation) => ({
          role: conversation.role,
          content: conversation.role === 'assistant'
            ? stripReasoningBlocks(stripToolPatterns(conversation.content))
            : conversation.content
        }))
        .filter((entry) => entry.content && entry.content.trim().length > 0);

    const userEntry = {
      role: 'user',
      content: messageText,
      metadata: this._buildMessageMetadata(channelMeta, hidden, {
        source: 'external_inbound'
      })
    };
    await this.db.addConversation(userEntry, resolvedSessionId, dbQueryOptions);
    if (this.chatContextService?.append) this.chatContextService.append(resolvedSessionId, userEntry);
    this._notifyConversationUpdate(resolvedSessionId);

    const sessionRow = typeof this.db.getChatSessionById === 'function'
      ? await this.db.getChatSessionById(resolvedSessionId, dbQueryOptions)
      : this.db.get('SELECT agent_id FROM chat_sessions WHERE id = ?', [resolvedSessionId]);
    const agentId = sessionRow?.agent_id || null;

    let response;
    if (this.chainController?.executeWithChaining) {
      response = await this.chainController.executeWithChaining(messageText, history, {
        sessionId: resolvedSessionId,
        agentId,
        requestContext
      });
    } else {
      response = await this.dispatcher.dispatch(messageText, history, {
        mode: 'chat',
        sessionId: resolvedSessionId,
        agentId,
        requestContext
      });
    }

    if (!response || !response.content) {
      response = {
        content: 'Sorry, I was unable to generate a response. Please try again.',
        model: 'unknown'
      };
    }

    const runtimeConfig = await this._getRuntimeForResponse(response);
    const assistantText = stripToolPatterns(buildAssistantContent(response, runtimeConfig));
    const assistantEntry = {
      role: 'assistant',
      content: assistantText,
      metadata: this._buildMessageMetadata(channelMeta, hidden, {
        source: 'external_outbound'
      })
    };
    await this.db.addConversation(assistantEntry, resolvedSessionId, dbQueryOptions);
    if (this.chatContextService?.append) this.chatContextService.append(resolvedSessionId, assistantEntry);
    if (this.chatContextService?.saveProviderContextUsage) {
      await this.chatContextService.saveProviderContextUsage(resolvedSessionId, response, buildDbQueryOptions(requestContext));
    }
    this._notifyConversationUpdate(resolvedSessionId);

    const selection = await getEffectiveLlmSelection(this.db, buildDbQueryOptions(requestContext));
    if (selection.provider && selection.model) {
      await rememberLastWorkingModel(this.db, selection.provider, selection.model, buildDbQueryOptions(requestContext));
    }

    return {
      success: true,
      sessionId: resolvedSessionId,
      content: assistantText,
      model: response.model || selection.model || '',
      provider: response?.renderContext?.provider || selection.provider || ''
    };
  }

  async newSession({ channel = 'external', chatId = '', requestContext = null }) {
    const created = await this.db.createChatSession(null, buildDbQueryOptions(requestContext));
    const newSessionId = String(created?.id || '');
    if (!newSessionId) {
      throw new Error('Failed to create a new chat session');
    }
    await this._setMappedSession(channel, chatId, newSessionId, requestContext);
    this._notifyConversationUpdate(newSessionId);
    return { success: true, sessionId: newSessionId };
  }

  async getSession({ channel = 'external', chatId = '', sessionId = null, requestContext = null }) {
    const resolved = await this.resolveSession({ channel, chatId, sessionId, requestContext });
    return { success: true, sessionId: resolved };
  }

  async clearSession({ channel = 'external', chatId = '', sessionId = null, requestContext = null }) {
    const resolved = await this.resolveSession({ channel, chatId, sessionId, requestContext });
    if (!resolved) {
      throw new Error('Unable to resolve session for clear');
    }
    await this.db.clearChatSession(resolved, buildDbQueryOptions(requestContext));
    if (this.chatContextService?.invalidate) this.chatContextService.invalidate(resolved);
    if (this.chatContextService?.clearProviderContextUsage) {
      await this.chatContextService.clearProviderContextUsage(resolved, buildDbQueryOptions(requestContext));
    }
    if (this.chatContextService?.clearContextCheckpoint) {
      await this.chatContextService.clearContextCheckpoint(resolved, buildDbQueryOptions(requestContext));
    }
    this._notifyConversationUpdate(resolved);
    return { success: true, sessionId: resolved };
  }

  async listProviders() {
    if (!this.aiService?.getProviders) {
      return [];
    }
    return this.aiService.getProviders();
  }

  async listModels(provider, requestContext = null) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (!normalizedProvider || !this.aiService?.getModels) {
      return [];
    }
    const models = await this.aiService.getModels(normalizedProvider, false, buildDbQueryOptions(requestContext));
    return Array.isArray(models) ? models : [];
  }

  async setGlobalModel(provider, model, requestContext = null) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedModel = String(model || '').trim();
    if (!normalizedProvider || !normalizedModel) {
      throw new Error('provider and model are required');
    }

    await saveActiveSelection(this.db, normalizedProvider, normalizedModel, buildDbQueryOptions(requestContext));
    await rememberTestedModel(this.db, normalizedProvider, normalizedModel, buildDbQueryOptions(requestContext));
    await rememberLastWorkingModel(this.db, normalizedProvider, normalizedModel, buildDbQueryOptions(requestContext));
    if (this.aiService?.setProvider) {
      await this.aiService.setProvider(normalizedProvider, buildDbQueryOptions(requestContext));
    }

    return { success: true, provider: normalizedProvider, model: normalizedModel };
  }

  async getGlobalModel(requestContext = null) {
    const selection = await getEffectiveLlmSelection(this.db, buildDbQueryOptions(requestContext));
    return {
      provider: selection.provider || '',
      model: selection.model || ''
    };
  }

  async setThinkingMode(mode, requestContext = null) {
    const normalizedMode = String(mode || '').trim().toLowerCase() === 'think' ? 'think' : 'off';
    const selection = await getEffectiveLlmSelection(this.db, buildDbQueryOptions(requestContext));
    if (selection.provider && selection.model) {
      const profile = await getModelRuntimeConfig(this.db, selection.provider, selection.model, buildDbQueryOptions(requestContext));
      await saveModelRuntimeConfig(this.db, selection.provider, selection.model, {
        reasoning: {
          ...profile.runtime.reasoning,
          enabled: normalizedMode === 'think'
        }
      }, buildDbQueryOptions(requestContext));
    }
    await (this.db.saveScopedSetting ? this.db.saveScopedSetting('llm.thinkingMode', normalizedMode, buildDbQueryOptions(requestContext)) : this.db.saveSetting('llm.thinkingMode', normalizedMode));
    await (this.db.saveScopedSetting ? this.db.saveScopedSetting('llm.showThinking', normalizedMode === 'think' ? 'true' : 'false', buildDbQueryOptions(requestContext)) : this.db.saveSetting('llm.showThinking', normalizedMode === 'think' ? 'true' : 'false'));
    return { success: true, mode: normalizedMode };
  }

  async setContextWindow(tokens, requestContext = null) {
    const saved = await saveActiveModelContext(this.db, tokens, buildDbQueryOptions(requestContext));
    return { ...saved, context_window: saved.contextWindow };
  }

  async stopGeneration() {
    const stopped = this.aiService?.stopGeneration ? this.aiService.stopGeneration() : false;
    if (this.chainController?.stopChain) {
      this.chainController.stopChain();
    }
    return { success: true, stopped: Boolean(stopped) };
  }
}

module.exports = ExternalChannelBridge;
