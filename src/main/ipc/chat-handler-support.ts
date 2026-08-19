// @ts-nocheck
const path = require('path');
const { getModelRuntimeConfig } = require('../llm-config');
const { getEffectiveLlmSelection } = require('../llm-state');
const { isPrivateSessionId } = require('../private-session-store');
const requestContextHelpers = require('../request-context');

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.cs', '.go', '.rs', '.cpp', '.c', '.h', '.hpp', '.rb', '.php', '.sh', '.ps1', '.bat', '.sql', '.xml', '.html', '.css', '.scss', '.less', '.csv', '.log']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);

function normalizeClientMessageMetadata(requestMeta) {
  if (!requestMeta || typeof requestMeta !== 'object') return null;
  const clientSource = String(requestMeta.clientSource || requestMeta.client_source || requestMeta.source || '').trim().toLowerCase();
  if (!clientSource) return null;
  const platform = String(requestMeta.platform || clientSource || '').trim().toLowerCase();
  const deviceId = String(requestMeta.deviceId || requestMeta.device_id || '').trim();
  const deviceName = String(requestMeta.deviceName || requestMeta.device_name || '').trim();
  const sourceLabel = String(requestMeta.sourceLabel || requestMeta.source_label || (clientSource === 'web' ? 'Web Client' : clientSource === 'mobile' ? 'Mobile Client' : 'Companion Client')).trim();
  return { clientSource, sourceLabel, platform: platform || clientSource, deviceId: deviceId || null, deviceName: deviceName || null };
}

function artifactKindFromExt(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

function createChatHandlerSupport(options = {}) {
  const db = options.db;
  const chatContextService = options.chatContextService;
  const dispatcher = options.dispatcher;
  const getTestMessages = options.getTestMessages;
  const ensureTestSession = options.ensureTestSession;
  const isTestSessionId = options.isTestSessionId;
  const privateSessionStore = options.privateSessionStore || null;
  const requestContextService = options.requestContextService || requestContextHelpers;
  const testClientMode = options.testClientMode === true;
  const testClientStore = options.testClientStore;

  function normalizeRequestContext(requestContext = null) {
    if (requestContextService?.normalizeRequestContext) {
      return requestContextService.normalizeRequestContext(requestContext || {});
    }
    return requestContext || {};
  }

  function getRequestContext(event = null) {
    return normalizeRequestContext(event?.requestContext || null);
  }

  function isConcurrentRequestContext(requestContext = null) {
    return requestContextService?.isConcurrentRequestContext
      ? requestContextService.isConcurrentRequestContext(requestContext || {})
      : false;
  }

  function getDbScopeFromRequestContext(requestContext = null) {
    const context = normalizeRequestContext(requestContext);
    return {
      requestContext: context,
      userId: context.userId || null
    };
  }

  function getDbScope(event = null) {
    return getDbScopeFromRequestContext(getRequestContext(event));
  }

  async function getSessionRow(sessionId, event = null) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    const scope = getDbScope(event);
    if (typeof db.getChatSessionById === 'function') {
      return db.getChatSessionById(sid, scope);
    }
    const row = db.get ? db.get('SELECT * FROM chat_sessions WHERE id = ?', [sid]) || null : null;
    if (!row) return null;
    const rowUserId = String(row.user_id || 'localuser').trim() || 'localuser';
    const scopedUserId = String(scope.userId || 'localuser').trim() || 'localuser';
    return rowUserId === scopedUserId ? row : null;
  }

  async function seedConcurrentSession(event = null) {
    const context = getRequestContext(event);
    const session = await db.getCurrentSession(getDbScopeFromRequestContext(context));
    if (session?.id && requestContextService?.setPreferredSessionId) {
      await requestContextService.setPreferredSessionId(db, context, session.id);
    }
    return session || null;
  }

  async function getCurrentSessionForEvent(event = null) {
    const context = getRequestContext(event);
    if (!isConcurrentRequestContext(context)) {
      return db.getCurrentSession(getDbScopeFromRequestContext(context));
    }
    const preferredId = requestContextService?.getPreferredSessionId
      ? await requestContextService.getPreferredSessionId(db, context)
      : null;
    if (preferredId) {
      const row = await getSessionRow(preferredId, event);
      if (row) {
        return row;
      }
      await requestContextService?.clearPreferredSessionId?.(db, context);
    }
    return seedConcurrentSession(event);
  }

  async function syncSelectedSession(sessionRow, event = null) {
    if (!sessionRow?.id) return;
    const context = getRequestContext(event);
    if (isConcurrentRequestContext(context)) {
      await requestContextService?.setPreferredSessionId?.(db, context, sessionRow.id);
      return;
    }
    await db.setCurrentSession(sessionRow.id, getDbScopeFromRequestContext(context));
  }

  async function resolveDbBackedSession(sessionId = null, event = null, options = {}) {
    const context = getRequestContext(event);
    const requested = String(sessionId || '').trim();
    let sid = requested;
    if (!sid) {
      if (isConcurrentRequestContext(context)) {
        sid = String(await requestContextService?.getPreferredSessionId?.(db, context) || '').trim();
        if (!sid) {
          sid = String((await seedConcurrentSession(event))?.id || '').trim();
        }
      } else {
        sid = String((await db.getCurrentSession(getDbScopeFromRequestContext(context)))?.id || '').trim();
      }
    }
    if (!sid) {
      return { success: false, error: 'No active session' };
    }
    const sessionRow = await getSessionRow(sid, event);
    if (!sessionRow) {
      if (isConcurrentRequestContext(context) && !requested) {
        await requestContextService?.clearPreferredSessionId?.(db, context);
      }
      if (requested || options.requireExisting) {
        return { success: false, error: `Chat session not found: ${sid}`, sessionId: sid };
      }
      return { success: false, error: 'No active session' };
    }
    await syncSelectedSession(sessionRow, event);
    return { success: true, sessionId: sid, session: sessionRow };
  }

  async function createChatSessionForEvent(title = null, event = null) {
    const context = getRequestContext(event);
    const concurrent = isConcurrentRequestContext(context);
    const session = await db.createChatSession(title, {
      ...getDbScopeFromRequestContext(context),
      makeCurrent: !concurrent
    });
    await resolveDbBackedSession(session?.id, event, { requireExisting: true });
    return session;
  }

  async function getHistory(limit = 100, sessionId = null, event = null) {
    if (isPrivateSessionId(sessionId) && privateSessionStore) return privateSessionStore.getMessages(sessionId, limit);
    if (testClientMode && (isTestSessionId(sessionId) || !sessionId)) return getTestMessages(sessionId, limit);
    const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: Boolean(String(sessionId || '').trim()) });
    if (!resolved?.success || !resolved.sessionId) return [];
    return db.getConversations(limit, resolved.sessionId, getDbScope(event));
  }

  async function persistMessage(message, sessionId = null, event = null) {
    let result;
    let effectiveSessionId = sessionId;
    if (isPrivateSessionId(sessionId) && privateSessionStore) {
      result = privateSessionStore.addMessage(sessionId, message);
    } else if (testClientMode && (isTestSessionId(sessionId) || !sessionId)) {
      const sid = ensureTestSession(sessionId);
      const session = testClientStore.sessions.get(sid);
      session.messages.push({ role: message.role, content: message.content, metadata: message.metadata || null, timestamp: new Date().toISOString() });
      effectiveSessionId = sid;
      result = message;
    } else {
      const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: Boolean(String(sessionId || '').trim()) });
      if (!resolved?.success || !resolved.sessionId) {
        throw new Error(resolved?.error || 'No active session found');
      }
      effectiveSessionId = resolved.sessionId;
      result = await db.addConversation(message, effectiveSessionId, getDbScope(event));
    }
    chatContextService.append(effectiveSessionId || sessionId, message);
    return result;
  }

  async function resolveInteractiveSession(requestedSessionId = null, event = null) {
    let resolved = await resolveDbBackedSession(requestedSessionId, event, {
      requireExisting: Boolean(String(requestedSessionId || '').trim())
    });
    if (!resolved?.success && !String(requestedSessionId || '').trim()) {
      const created = await createChatSessionForEvent(null, event);
      resolved = await resolveDbBackedSession(created?.id, event, { requireExisting: true });
    }
    return resolved;
  }

  async function resolveRuntimeForResponse(response) {
    const responseRuntime = response?.renderContext?.runtimeConfig;
    if (responseRuntime && typeof responseRuntime === 'object') return responseRuntime;
    const provider = response?.renderContext?.provider;
    const model = response?.renderContext?.model;
    if (provider && model) {
      const { runtime } = await getModelRuntimeConfig(db, provider, model);
      return runtime;
    }
    const { provider: activeProvider, model: activeModel } = await getEffectiveLlmSelection(db);
    if (activeProvider && activeModel) {
      const { runtime } = await getModelRuntimeConfig(db, activeProvider, activeModel);
      return runtime;
    }
    return null;
  }

  return {
    artifactKindFromExt,
    createChatSessionForEvent,
    getCurrentSessionForEvent,
    getDbScope,
    getHistory,
    getRequestContext,
    getSessionRow,
    isConcurrentRequestContext,
    normalizeClientMessageMetadata,
    persistMessage,
    resolveDbBackedSession,
    resolveInteractiveSession,
    resolveRuntimeForResponse
  };
}

module.exports = {
  createChatHandlerSupport
};

