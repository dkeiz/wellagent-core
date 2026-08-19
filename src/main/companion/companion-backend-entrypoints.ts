// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { getEffectiveLlmSelection } = require('../llm-state');
const { getModelRuntimeConfig, saveModelRuntimeConfig } = require('../llm-config');
const { createChatContextService } = require('../chat-context-service');
const requestContextHelpers = require('../request-context');
const {
  stripToolPatterns,
  stripReasoningBlocks,
  buildAssistantContent
} = require('../ipc/shared-utils');

function normalizeClientMessageMetadata(requestMeta) {
  if (!requestMeta || typeof requestMeta !== 'object') return null;
  const clientSource = String(
    requestMeta.clientSource || requestMeta.client_source || requestMeta.source || ''
  ).trim().toLowerCase();
  if (!clientSource) return null;
  return {
    clientSource,
    sourceLabel: String(
      requestMeta.sourceLabel
      || requestMeta.source_label
      || (clientSource === 'web' ? 'Web Client' : clientSource === 'mobile' ? 'Mobile Client' : 'Companion Client')
    ).trim(),
    platform: String(requestMeta.platform || clientSource || '').trim().toLowerCase() || clientSource,
    deviceId: String(requestMeta.deviceId || requestMeta.device_id || '').trim() || null,
    deviceName: String(requestMeta.deviceName || requestMeta.device_name || '').trim() || null
  };
}

function artifactKindFromExt(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext)) return 'audio';
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'].includes(ext)) return 'video';
  if (['.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.log', '.csv'].includes(ext)) return 'text';
  return 'binary';
}

async function getSessionRow(db, sessionId, options = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const scopedUserId = String(options?.userId || options?.requestContext?.userId || '').trim();
  const matchesScope = (row) => {
    if (!row) return null;
    const rowUserId = String(row.user_id || '').trim();
    return rowUserId === scopedUserId ? row : null;
  };
  if (typeof db.getChatSessionById === 'function') {
    return matchesScope(await db.getChatSessionById(sid, options));
  }
  if (typeof db.get === 'function') {
    return matchesScope(db.get('SELECT * FROM chat_sessions WHERE id = ?', [sid]) || null);
  }
  if (typeof db.getChatSessions === 'function') {
    const sessions = await db.getChatSessions(null, 1000, options);
    return matchesScope((sessions || []).find(session => String(session.id) === sid) || null);
  }
  return null;
}

function createCompanionBackendEntrypoints(container) {
  const db = container.get('db');
  const dispatcher = container.optional('dispatcher');
  const aiService = container.optional('aiService');
  const capabilityManager = container.optional('capabilityManager');
  const agentManager = container.optional('agentManager');
  const memoryDaemon = container.optional('memoryDaemon');
  const workflowScheduler = container.optional('workflowScheduler');
  const chainController = container.optional('chainController');
  const sessionWorkspace = container.optional('sessionWorkspace');
  const taskQueueService = container.optional('taskQueueService');
  const mcpServer = container.optional('mcpServer');
  const artifactRegistry = container.optional('artifactRegistry');
  const windowManager = container.optional('windowManager');
  const requestContextService = container.optional('requestContextService') || requestContextHelpers;
  const chatContextService = container.optional('chatContextService') || createChatContextService({
    db,
    dispatcher,
    cleaners: { stripToolPatterns, stripReasoningBlocks }
  });
  const sessionCompactionService = container.optional('sessionCompactionService');

  function normalizeRequestContext(requestContext = null) {
    if (requestContextService?.normalizeRequestContext) {
      return requestContextService.normalizeRequestContext(requestContext || {});
    }
    return requestContext || {};
  }

  function isConcurrentRequestContext(requestContext = null) {
    return requestContextService?.isConcurrentRequestContext
      ? requestContextService.isConcurrentRequestContext(requestContext || {})
      : false;
  }

  function getDbScope(requestContext = null) {
    const context = normalizeRequestContext(requestContext);
    if (!context.userId) {
      throw new Error('Companion request context requires a concrete user');
    }
    return { requestContext: context, userId: context.userId };
  }

  async function seedConcurrentSession(requestContext = null) {
    const context = normalizeRequestContext(requestContext);
    const session = await db.getCurrentSession(getDbScope(context));
    if (session?.id && requestContextService?.setPreferredSessionId) {
      await requestContextService.setPreferredSessionId(db, context, session.id);
    }
    return session || null;
  }

  async function getCurrentChatSessionForContext(requestContext = null) {
    const context = normalizeRequestContext(requestContext);
    if (!isConcurrentRequestContext(context)) {
      return db.getCurrentSession(getDbScope(context));
    }

    const preferredId = requestContextService?.getPreferredSessionId
      ? await requestContextService.getPreferredSessionId(db, context)
      : null;
    if (preferredId) {
      const row = await getSessionRow(db, preferredId, getDbScope(context));
      if (row) {
        return row;
      }
      await requestContextService?.clearPreferredSessionId?.(db, context);
    }

    return seedConcurrentSession(context);
  }

  async function syncSelectedSession(sessionRow, requestContext = null) {
    if (!sessionRow?.id) return;
    const context = normalizeRequestContext(requestContext);

    if (isConcurrentRequestContext(context)) {
      await requestContextService?.setPreferredSessionId?.(db, context, sessionRow.id);
      return;
    }

    await db.setCurrentSession(sessionRow.id, getDbScope(context));
    if (mcpServer?.setCurrentSessionId) mcpServer.setCurrentSessionId(sessionRow.id);
    if (mcpServer?.setCurrentAgentContext) {
      const agentId = sessionRow?.agent_id || null;
      mcpServer.setCurrentAgentContext(agentId ? { sessionId: sessionRow.id, agentId } : null);
    }
  }

  async function resolveChatSession(sessionId = null, { requireExisting = false, requestContext = null } = {}) {
    const context = normalizeRequestContext(requestContext);
    const requested = String(sessionId || '').trim();
    let sid = requested;

    if (!sid) {
      if (isConcurrentRequestContext(context)) {
        sid = String(await requestContextService?.getPreferredSessionId?.(db, context) || '').trim();
        if (!sid) {
          sid = String((await seedConcurrentSession(context))?.id || '').trim();
        }
      } else {
        sid = String((await db.getCurrentSession(getDbScope(context)))?.id || '').trim();
      }
    }
    if (!sid) return { success: false, error: 'No active session' };

    const sessionRow = await getSessionRow(db, sid, getDbScope(context));
    if (!sessionRow) {
      if (isConcurrentRequestContext(context) && !requested) {
        await requestContextService?.clearPreferredSessionId?.(db, context);
      }
      if (requested || requireExisting) {
        return { success: false, error: `Chat session not found: ${sid}`, sessionId: sid };
      }
      return { success: false, error: 'No active session' };
    }

    await syncSelectedSession(sessionRow, context);
    return { success: true, sessionId: sid, session: sessionRow || null };
  }

  async function createChatSessionForContext(title = null, requestContext = null) {
    const concurrent = isConcurrentRequestContext(requestContext);
    const scope = getDbScope(requestContext);
    const session = await db.createChatSession(title, { ...scope, makeCurrent: !concurrent });
    await resolveChatSession(session?.id, { requireExisting: false, requestContext });
    return session;
  }

  function buildConversationUpdatePayload(sessionId, requestContext = null, extra = {}) {
    const context = normalizeRequestContext(requestContext);
    const payload = {
      sessionId,
      currentSessionId: sessionId,
      ...extra
    };
    if (isConcurrentRequestContext(context) && context.deviceId) {
      payload.deviceId = context.deviceId;
    }
    return payload;
  }

  return {
    async getSettingsSnapshot(requestContext = null) {
      const { provider, model } = await getEffectiveLlmSelection(db, getDbScope(requestContext));
      let runtimeConfig = null;
      if (provider && model) {
        runtimeConfig = (await getModelRuntimeConfig(db, provider, model, getDbScope(requestContext))).runtime;
      }
      return {
        model: model || '',
        runtimeConfig: runtimeConfig || null,
        concurrencyEnabled: (await db.getScopedSetting?.('llm.concurrency.enabled', getDbScope(requestContext))) === 'true',
        capabilities: capabilityManager?.getState?.() || { mainEnabled: false, groups: {}, activeToolCount: 0 },
        agents: agentManager?.getAgents ? await agentManager.getAgents(null, getDbScope(requestContext)) : [],
        memoryStatus: memoryDaemon?.getStatus ? memoryDaemon.getStatus() : { running: false },
        workflowStatus: workflowScheduler?.getStatus ? workflowScheduler.getStatus() : { running: false }
      };
    },

    async listAgents(requestContext = null) {
      return agentManager?.getAgents ? agentManager.getAgents(null, getDbScope(requestContext)) : [];
    },

    async setAgentActive(agentId, active, requestContext = null) {
      if (!agentManager) return { success: false, error: 'Agent manager unavailable' };
      if (active === false) {
        await agentManager.deactivateAgent(agentId, getDbScope(requestContext));
        return { success: true };
      }
      return agentManager.activateAgent(agentId, getDbScope(requestContext));
    },

    async listChatSessions(limit = 20, requestContext = null) {
      return db.getChatSessions(null, limit, getDbScope(requestContext));
    },

    async getCurrentChatSession(requestContext = null) {
      return getCurrentChatSessionForContext(requestContext);
    },

    async createChatSession(requestContext = null) {
      const session = await createChatSessionForContext(null, requestContext);
      if (session?.id) {
        windowManager?.send?.('conversation-update', buildConversationUpdatePayload(session.id, requestContext));
      }
      return session;
    },

    async switchChatSession(sessionId, requestContext = null) {
      if (!String(sessionId || '').trim()) return { success: false, error: 'Missing sessionId' };
      const result = await resolveChatSession(sessionId, { requireExisting: true, requestContext });
      if (result?.success && result.sessionId) {
        windowManager?.send?.('conversation-update', buildConversationUpdatePayload(result.sessionId, requestContext));
      }
      return result;
    },

    async getConversations(limit = 80, sessionId = '', requestContext = null) {
      const resolved = await resolveChatSession(String(sessionId || '').trim() || null, {
        requireExisting: Boolean(String(sessionId || '').trim()),
        requestContext
      });
      if (!resolved?.success || !resolved.sessionId) {
        return [];
      }
      return db.getConversations(limit, resolved.sessionId, getDbScope(requestContext));
    },

    async sendMessage(message, sessionId = null, requestMeta = null, requestContext = null) {
      const text = String(message || '').trim();
      if (!text) throw new Error('Message is required');
      const context = normalizeRequestContext(requestContext);
      let resolved = await resolveChatSession(sessionId, { requireExisting: Boolean(sessionId), requestContext: context });
      if (!resolved?.success && !String(sessionId || '').trim()) {
        const created = await createChatSessionForContext(null, context);
        resolved = await resolveChatSession(created?.id, { requireExisting: true, requestContext: context });
      }
      if (!resolved?.success) return resolved;
      const sid = resolved.sessionId;

      const dbScope = getDbScope(context);
      if (text.toLowerCase() === '/compact') {
        if (!sessionCompactionService?.compactSession) {
          return { success: false, sessionId: sid, error: 'Session compaction service is unavailable' };
        }
        return sessionCompactionService.compactSession(sid, dbScope);
      }
      const history = await chatContextService.buildPromptHistory(sid, text, { dbQueryOptions: dbScope });
      const normalizedMeta = normalizeClientMessageMetadata(requestMeta);

      await db.addConversation({
        role: 'user',
        content: text,
        metadata: normalizedMeta
      }, sid, dbScope);
      chatContextService.append(sid, {
        role: 'user',
        content: text,
        metadata: normalizedMeta
      });
      windowManager?.send?.(
        'conversation-update',
        buildConversationUpdatePayload(sid, context, { phase: 'user-message' })
      );

      const agentId = resolved.session?.agent_id || null;
      const response = chainController?.executeWithChaining
        ? await chainController.executeWithChaining(text, history, { sessionId: sid, agentId, requestContext: context })
        : await dispatcher.dispatch(text, history, { mode: 'chat', sessionId: sid, agentId, requestContext: context });
      if (response?.needsPermission) {
        return { needsPermission: true, sessionId: sid, ...response.permissionRequest, ...response };
      }
      const cleanContent = stripToolPatterns(buildAssistantContent(response, response?.renderContext?.runtimeConfig || null));
      await db.addConversation({ role: 'assistant', content: cleanContent }, sid, dbScope);
      chatContextService.append(sid, { role: 'assistant', content: cleanContent });
      await chatContextService.saveProviderContextUsage(sid, response, getDbScope(context));
      windowManager?.send?.('conversation-update', buildConversationUpdatePayload(sid, context));
      return { ...response, content: cleanContent, sessionId: sid };
    },

    stopGeneration() {
      const stopped = aiService?.stopGeneration ? aiService.stopGeneration() : false;
      if (chainController?.stopChain) chainController.stopChain();
      return { stopped };
    },

    async setThinkingMode(mode, requestContext = null) {
      const nextMode = mode === 'off' ? 'off' : 'think';
      const { provider, model } = await getEffectiveLlmSelection(db, getDbScope(requestContext));
      if (provider && model) {
        const profile = await getModelRuntimeConfig(db, provider, model, getDbScope(requestContext));
        const saved = await saveModelRuntimeConfig(db, provider, model, {
          reasoning: {
            ...profile.runtime.reasoning,
            enabled: nextMode === 'think'
          }
        }, getDbScope(requestContext));
        await (db.saveScopedSetting ? db.saveScopedSetting('llm.thinkingMode', saved.runtime.reasoning.enabled ? 'think' : 'off', getDbScope(requestContext)) : db.saveSetting('llm.thinkingMode', saved.runtime.reasoning.enabled ? 'think' : 'off')); 
        await (db.saveScopedSetting ? db.saveScopedSetting('llm.showThinking', saved.runtime.reasoning.visibility === 'hide' ? 'false' : 'true', getDbScope(requestContext)) : db.saveSetting('llm.showThinking', saved.runtime.reasoning.visibility === 'hide' ? 'false' : 'true')); 
        await (db.saveScopedSetting ? db.saveScopedSetting('llm.thinkingVisibility', saved.runtime.reasoning.visibility || 'show', getDbScope(requestContext)) : db.saveSetting('llm.thinkingVisibility', saved.runtime.reasoning.visibility || 'show')); 
      } else {
        await (db.saveScopedSetting ? db.saveScopedSetting('llm.thinkingMode', nextMode, getDbScope(requestContext)) : db.saveSetting('llm.thinkingMode', nextMode));
      }
      return { success: true, mode: nextMode };
    },

    setCapabilityMain(enabled) {
      if (!capabilityManager?.setMainEnabled) return { success: false, error: 'Capability manager unavailable' };
      const value = capabilityManager.setMainEnabled(enabled === true);
      return { success: true, mainEnabled: value };
    },

    async setCapabilityGroup(groupId, enabled) {
      if (!capabilityManager?.setGroupEnabled) return { success: false, error: 'Capability manager unavailable' };
      const value = capabilityManager.setGroupEnabled(groupId, enabled === true);
      return { success: value };
    },

    async setDaemonRunning(kind, running) {
      const daemonKind = kind === 'workflow' ? 'workflow' : 'memory';
      if (daemonKind === 'memory') {
        if (!memoryDaemon) return { success: false, error: 'Memory daemon unavailable' };
        if (running) await memoryDaemon.start();
        else memoryDaemon.stop();
        return { success: true };
      }
      if (!workflowScheduler) return { success: false, error: 'Workflow scheduler unavailable' };
      if (running) await workflowScheduler.start();
      else workflowScheduler.stop();
      return { success: true };
    },

    async listTaskQueue(actionable = true) {
      if (!taskQueueService?.listTasks) return { success: false, error: 'Task queue unavailable', tasks: [] };
      return taskQueueService.listTasks({ actionable: actionable !== false });
    },

    async updateTask(action, taskId) {
      if (!taskQueueService) return { success: false, error: 'Task queue unavailable' };
      if (action === 'approve' && taskQueueService.approveTask) {
        return taskQueueService.approveTask(taskId, { actor: 'companion-web' });
      }
      if (action === 'cancel' && taskQueueService.cancelTask) {
        return taskQueueService.cancelTask(taskId, { actor: 'companion-web' });
      }
      if (action === 'defer' && taskQueueService.deferTask) {
        return taskQueueService.deferTask(taskId, 15, { actor: 'companion-web', reason: 'Deferred by companion' });
      }
      return { success: false, error: 'Unsupported task action' };
    },

    async clearChatSession(sessionId, requestContext = null) {
      const sid = String(sessionId || '').trim();
      if (!sid) return { success: false, error: 'Missing sessionId' };
      const resolved = await resolveChatSession(sid, { requireExisting: true, requestContext });
      if (!resolved?.success || !resolved.sessionId) return resolved;
      await db.clearChatSession(resolved.sessionId, getDbScope(requestContext));
      chatContextService.invalidate(resolved.sessionId);
      await chatContextService.clearProviderContextUsage(resolved.sessionId, getDbScope(requestContext));
      await chatContextService.clearContextCheckpoint(resolved.sessionId, getDbScope(requestContext));
      return { cleared: true, sessionId: resolved.sessionId };
    },

    async getSessionArtifacts(sessionId = null, requestContext = null) {
      let sid = String(sessionId || '').trim();
      if (!sid) {
        sid = String((await getCurrentChatSessionForContext(requestContext))?.id || '').trim();
      }
      if (!sid) {
        return { success: true, sessionId: sid, files: [], artifacts: [], fileCount: 0 };
      }
      if (String(sessionId || '').trim() && !(await getSessionRow(db, sid, getDbScope(requestContext)))) {
        return { success: false, error: `Chat session not found: ${sid}`, sessionId: sid, files: [], artifacts: [], fileCount: 0 };
      }
      if (artifactRegistry?.listArtifacts) {
        const { artifacts, count } = artifactRegistry.listArtifacts(sid, { openableOnly: true });
        const files = artifacts.map(artifact => ({
          key: artifact.key,
          name: artifact.name,
          size: artifact.size || 0,
          created: artifact.timestamp,
          kind: artifact.kind,
          category: artifact.category,
          source: artifact.source,
          action: artifact.action,
          virtual: artifact.virtual || false,
          accepted: artifact.accepted || false
        })).filter(artifact => artifact.virtual !== true);
        return { success: true, sessionId: sid, files, artifacts: files, fileCount: files.length };
      }
      if (!sessionWorkspace?.listFiles) {
        return { success: true, sessionId: sid, files: [], artifacts: [], fileCount: 0 };
      }
      const files = sessionWorkspace.listFiles(sid)
        .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
        .map((file) => ({
          name: file.name,
          size: file.size,
          created: file.created,
          kind: artifactKindFromExt(file.name)
        }));
      return { success: true, sessionId: sid, files, artifacts: files, fileCount: files.length };
    },

    async readSessionArtifact(sessionId, fileName, requestContext = null) {
      const sid = String(sessionId || '').trim();
      if (!sid) return { success: false, error: 'Missing sessionId' };
      if (!(await getSessionRow(db, sid, getDbScope(requestContext)))) return { success: false, error: `Chat session not found: ${sid}` };
      if (!sessionWorkspace?.getWorkspacePath) return { success: false, error: 'Session workspace unavailable' };
      const safeName = path.basename(String(fileName || ''));
      if (!safeName || safeName !== String(fileName || '')) return { success: false, error: 'Invalid artifact name' };
      const workspaceDir = sessionWorkspace.getWorkspacePath(sid);
      const artifactPath = path.resolve(workspaceDir, safeName);
      if (!artifactPath.startsWith(path.resolve(workspaceDir) + path.sep)) {
        return { success: false, error: 'Requested artifact is outside workspace' };
      }
      if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { success: false, error: 'Artifact file not found' };
      }
      const stat = fs.statSync(artifactPath);
      const kind = artifactKindFromExt(safeName);
      let content = null;
      if (kind === 'text' && stat.size <= 1024 * 1024) {
        content = fs.readFileSync(artifactPath, 'utf-8');
      }
      return { success: true, name: safeName, size: stat.size, kind, path: artifactPath, content };
    }
  };
}

module.exports = {
  createCompanionBackendEntrypoints
};



