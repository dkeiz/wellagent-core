// @ts-nocheck
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { getEffectiveLlmSelection, rememberLastWorkingModel } = require('../llm-state'); const { stripToolPatterns, stripReasoningBlocks, buildAssistantContent } = require('./shared-utils');
const { isPrivateSessionId } = require('../private-session-store'); const { saveGenericSetting } = require('../settings-security');
const { createChatContextService } = require('../chat-context-service'); const { createChatHandlerSupport } = require('./chat-handler-support');
const { LiveTurn } = require('../live-turn');
const { SessionMemoryRefresh } = require('../session-memory-refresh'); const { compactResponseDiagnostics, persistResponseError } = require('../response-diagnostics');
function registerChatDataHandlers(ipcMain, runtime, helpers) { const { db, mcpServer, windowManager, chainController, agentLoop, agentManager, dispatcher, sessionWorkspace, sessionInitManager, promptFileManager, memoryDaemon, taskQueueService, executionDirectory, capabilityManager, privateSessionStore, privateModeDefault, testClientMode, testClientStore, artifactRegistry, chatContextService: runtimeChatContextService, sessionCompactionService, opencodeRuntimeManager } = runtime; const { markUserActive, markUserIdle } = helpers;
  function isTestSessionId(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('testclient-');
  }
  function ensurePrivateSession(sessionId = null, options = {}) {
    if (!privateSessionStore) return sessionId;
    return (sessionId && isPrivateSessionId(sessionId)) ? privateSessionStore.ensureSession(sessionId).id : privateSessionStore.createSession(options || {}).id;
  }
  function ensureTestSession(sessionId = null) {
    if (!testClientMode) return sessionId;
    if (sessionId && isTestSessionId(sessionId)) {
      if (!testClientStore.sessions.has(sessionId)) testClientStore.sessions.set(sessionId, { id: sessionId, title: 'Test Client', created_at: new Date().toISOString(), messages: [] });
      return testClientStore.currentSessionId = sessionId;
    }
    if (testClientStore.currentSessionId && testClientStore.sessions.has(testClientStore.currentSessionId)) return testClientStore.currentSessionId;
    const id = `testclient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    testClientStore.sessions.set(id, { id, title: `Test Chat ${new Date().toLocaleTimeString()}`, created_at: new Date().toISOString(), messages: [] });
    return testClientStore.currentSessionId = id;
  }
  function getTestMessages(sessionId, limit = 100) {
    const sid = ensureTestSession(sessionId);
    const session = testClientStore.sessions.get(sid);
    if (!session) return [];
    return session.messages.slice(-limit).map(m => ({ ...m, timestamp: m.timestamp || new Date().toISOString() }));
  }
  const chatContextService = runtimeChatContextService || createChatContextService({
    db,
    dispatcher,
    privateSessionStore,
    testClientMode,
    testClientStore,
    getTestMessages,
    cleaners: { stripToolPatterns, stripReasoningBlocks }
  });
  const memoryRefresh = new SessionMemoryRefresh(chatContextService); const sessionSendQueues = new Map();
  const { artifactKindFromExt, createChatSessionForEvent, getCurrentSessionForEvent, getDbScope, getHistory, getRequestContext, getSessionRow, isConcurrentRequestContext, normalizeClientMessageMetadata, persistMessage, resolveDbBackedSession, resolveInteractiveSession, resolveRuntimeForResponse } = createChatHandlerSupport({
    chatContextService,
    db,
    ensureTestSession,
    getTestMessages,
    isTestSessionId,
    privateSessionStore,
    requestContextService: runtime.requestContextService || runtime.container?.optional?.('requestContextService') || null,
    testClientMode,
    testClientStore
  });
  const attachmentTypes = new Map([
    ['.png', ['image', 'image/png']], ['.jpg', ['image', 'image/jpeg']], ['.jpeg', ['image', 'image/jpeg']],
    ['.gif', ['image', 'image/gif']], ['.webp', ['image', 'image/webp']], ['.bmp', ['image', 'image/bmp']],
    ['.mp3', ['audio', 'audio/mpeg']], ['.wav', ['audio', 'audio/wav']], ['.ogg', ['audio', 'audio/ogg']],
    ['.m4a', ['audio', 'audio/mp4']]
  ]);
  const inlineTextAttachmentExtensions = new Set([
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.yaml', '.yml',
    '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go',
    '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.ps1', '.sql', '.toml',
    '.ini', '.cfg', '.conf', '.log'
  ]);
  function attachmentRoot(sessionId) {
    if (!sessionWorkspace?.getWorkspacePath) throw new Error('Session workspace unavailable');
    return path.resolve(sessionWorkspace.getWorkspacePath(sessionId), 'attachments');
  }
  function normalizeIncomingChatMessage(value, sessionId) {
    const payload = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { text: String(value || ''), attachments: [] };
    const text = String(payload.text || '');
    const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const rootPrefix = rawAttachments.length > 0 ? attachmentRoot(sessionId) + path.sep : '';
    const attachments = rawAttachments.map((item) => {
      const filePath = path.resolve(String(item?.path || ''));
      if (!filePath.startsWith(rootPrefix) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error('Attachment is outside the active session workspace');
      }
      const ext = path.extname(filePath).toLowerCase();
      const [type, mimeType] = attachmentTypes.get(ext) || ['document', 'application/octet-stream'];
      return {
        id: String(item?.id || crypto.randomUUID()),
        name: path.basename(String(item?.name || filePath)),
        path: filePath,
        type,
        mimeType,
        size: fs.statSync(filePath).size
      };
    });
    return { text, attachments };
  }
  function buildAttachmentPrompt(text, attachments) {
    const sections = [];
    for (const attachment of attachments) {
      if (attachment.type === 'image') {
        sections.push(`[Image attachment: ${attachment.name}]`);
        continue;
      }
      const ext = path.extname(attachment.path).toLowerCase();
      if (attachment.type === 'document' && inlineTextAttachmentExtensions.has(ext) && attachment.size <= 512 * 1024) {
        try {
          sections.push(`<attachment name="${attachment.name}">\n${fs.readFileSync(attachment.path, 'utf8')}\n</attachment>`);
          continue;
        } catch (_) {
        }
      }
      sections.push(`[Attachment: ${attachment.name} (${attachment.mimeType})]`);
    }
    return [String(text || '').trim(), sections.join('\n\n')].filter(Boolean).join('\n\n');
  }
  ipcMain.handle('get-calendar-events', async (event) => db.getCalendarEvents(getDbScope(event)));
  ipcMain.handle('add-calendar-event', async (event, calendarEvent) => {
    const result = await db.addCalendarEvent(calendarEvent, getDbScope(event));
    windowManager.send('calendar-update');
    return result;
  });
  ipcMain.handle('update-calendar-event', async (event, id, calendarEvent) => {
    const result = await db.updateCalendarEvent(id, calendarEvent, getDbScope(event));
    windowManager.send('calendar-update');
    return result;
  });
  ipcMain.handle('delete-calendar-event', async (event, id) => {
    const result = await db.deleteCalendarEvent(id, getDbScope(event));
    windowManager.send('calendar-update');
    return result;
  });
  ipcMain.handle('get-todos', async (event, sessionId = null) => db.getTodos(sessionId, getDbScope(event)));
  ipcMain.handle('add-todo', async (event, todo, sessionId = null) => {
    const result = await db.addTodo(todo, sessionId, getDbScope(event));
    windowManager.send('todo-update');
    return result;
  });
  ipcMain.handle('update-todo', async (event, id, todo, sessionId = null) => {
    const result = await db.updateTodo(id, todo, sessionId, getDbScope(event));
    windowManager.send('todo-update');
    return result;
  });
  ipcMain.handle('delete-todo', async (event, id, sessionId = null) => {
    const result = await db.deleteTodo(id, sessionId, getDbScope(event));
    windowManager.send('todo-update');
    return result;
  });
  async function executeTaskAction(task, context = {}) {
    const action = String(task?.action || '').trim().toLowerCase();
    const payload = task?.payload && typeof task.payload === 'object' ? task.payload : {};
    if (!action || action === 'none' || action === 'chat.request_decision') {
      return {
        success: true,
        summary: `Task ${task.id} acknowledged for chat handling.`
      };
    }
    if (action === 'daemon.enqueue_memory_job') {
      const sessionId = String(payload.sessionId || '').trim();
      if (!sessionId) {
        throw new Error('Missing payload.sessionId for daemon.enqueue_memory_job');
      }
      if (isPrivateSessionId(sessionId)) {
        throw new Error('Private sessions cannot be queued for background memory jobs');
      }
      await db.enqueueMemoryJob({
        jobType: String(payload.jobType || 'summarize_session'),
        sessionId,
        payload: {
          source: payload.source || 'task_queue_manual_run',
          enqueued_at: new Date().toISOString(),
          global_task_id: task.id
        }
      });
      return {
        success: true,
        summary: `Queued ${payload.jobType || 'summarize_session'} for session ${sessionId}.`
      };
    }
    if (action === 'subagent.delegate') {
      if (!agentManager || typeof agentManager.invokeSubAgent !== 'function') {
        throw new Error('Sub-agent runtime is unavailable');
      }
      const subagentId = Number(payload.subagentId || payload.subagent_id || 0);
      const delegatedTask = String(payload.task || payload.prompt || '').trim();
      if (!subagentId || !delegatedTask) {
        throw new Error('subagent.delegate requires payload.subagentId and payload.task');
      }
      const parentSessionId = context.sessionId || null;
      const run = await agentManager.invokeSubAgent(parentSessionId, subagentId, delegatedTask, {
        contractType: payload.contract_type || payload.contractType || 'task_complete',
        expectedOutput: payload.expected_output || payload.expectedOutput || '',
        subagentMode: payload.subagent_mode || payload.subagentMode || 'no_ui',
        permissionsContract: payload.permissions_contract || payload.permissionsContract || null,
        requestContext: context.requestContext || null
      });
      return {
        success: true,
        delegated: true,
        run,
        summary: `Delegated to subagent ${subagentId} (${run.run_id}).`
      };
    }
    throw new Error(`Unsupported task action: ${action}`);
  }
  ipcMain.handle('task-queue:list', async (event, options = {}) => {
    if (!taskQueueService?.listTasks) return { success: false, error: 'Task queue service unavailable', tasks: [] };
    return taskQueueService.listTasks({ ...(options || {}), requestContext: event?.requestContext || null });
  });
  ipcMain.handle('task-queue:approve', async (event, taskId, options = {}) => {
    if (!taskQueueService?.approveTask) return { success: false, error: 'Task queue service unavailable' };
    return taskQueueService.approveTask(taskId, { actor: options.actor || 'chat-user', requestContext: event?.requestContext || null });
  });
  ipcMain.handle('task-queue:cancel', async (event, taskId, options = {}) => {
    if (!taskQueueService?.cancelTask) return { success: false, error: 'Task queue service unavailable' };
    return taskQueueService.cancelTask(taskId, { actor: options.actor || 'chat-user', requestContext: event?.requestContext || null });
  });
  ipcMain.handle('task-queue:defer', async (event, taskId, minutes = 5, options = {}) => {
    if (!taskQueueService?.deferTask) return { success: false, error: 'Task queue service unavailable' };
    return taskQueueService.deferTask(taskId, minutes, {
      actor: options.actor || 'chat-user',
      reason: options.reason || 'Deferred by user',
      requestContext: event?.requestContext || null
    });
  });
  ipcMain.handle('task-queue:run', async (event, taskId, context = {}) => {
    if (!taskQueueService?.claimTaskById) return { success: false, error: 'Task queue service unavailable' };
    const claimed = await taskQueueService.claimTaskById(taskId, {
      owner: context.owner || 'chat',
      actor: context.actor || 'chat-user',
      allowFuture: context.allowFuture === true,
      requestContext: event?.requestContext || null
    });
    if (!claimed?.success) {
      return claimed || { success: false, error: 'Failed to claim task' };
    }
    try {
      const execResult = await executeTaskAction(claimed.task, context || {});
      if (execResult.deferred && taskQueueService?.deferTask) {
        await taskQueueService.deferTask(claimed.task.id, Number(execResult.deferMinutes || 5), {
          actor: context.actor || 'chat-user',
          reason: execResult.reason || 'Deferred by task executor',
          tasksFilePath: claimed.task._queueFilePath
        });
      } else {
        await taskQueueService.completeTask(claimed.task.id, {
          actor: context.actor || 'chat-user',
          summary: execResult.summary || 'Task executed successfully',
          tasksFilePath: claimed.task._queueFilePath
        });
      }
      if (memoryDaemon && context.triggerDaemonRun === true && memoryDaemon.runNow) {
        memoryDaemon.runNow().catch(() => {});
      }
      return { success: true, taskId: claimed.task.id, result: execResult };
    } catch (error) {
      await taskQueueService.failTask(claimed.task.id, error.message, {
        actor: context.actor || 'chat-user',
        tasksFilePath: claimed.task._queueFilePath
      });
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('task-queue:create-or-reuse', async (event, taskInput, options = {}) => {
    if (!taskQueueService?.createOrReuseTask) return { success: false, error: 'Task queue service unavailable' };
    return taskQueueService.createOrReuseTask(taskInput || {}, { actor: options.actor || 'chat-user', requestContext: event?.requestContext || null });
  });
  ipcMain.handle('get-conversations', async (event, limit = 100, sessionId = null) => {
    return getHistory(limit, sessionId, event);
  });
  ipcMain.handle('get-context-usage-estimate', async (event, sessionId = null, currentPrompt = '') => {
    if (isPrivateSessionId(sessionId) || (testClientMode && (isTestSessionId(sessionId) || !sessionId))) {
      const effectiveSessionId = testClientMode && !sessionId ? ensureTestSession(sessionId) : sessionId;
      return chatContextService.getUsageEstimate(effectiveSessionId, currentPrompt);
    }
    const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: Boolean(String(sessionId || '').trim()) });
    if (String(sessionId || '').trim() && !resolved?.success) {
      throw new Error(resolved?.error || `Chat session not found: ${String(sessionId || '').trim()}`);
    }
    const dbScope = getDbScope(event);
    return chatContextService.getUsageEstimate(resolved?.success ? resolved.sessionId : null, currentPrompt, {
      dbQueryOptions: dbScope,
      requestContext: getRequestContext(event),
      userId: dbScope?.userId,
      agentId: resolved?.session?.agent_id || null
    });
  });
  ipcMain.handle('compact-chat-session', async (event, sessionId) => {
    if (!sessionCompactionService?.compactSession) {
      throw new Error('Session compaction service is unavailable');
    }
    const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: true });
    if (!resolved?.success || !resolved.sessionId) {
      throw new Error(resolved?.error || `Chat session not found: ${String(sessionId || '').trim()}`);
    }
    return sessionCompactionService.compactSession(resolved.sessionId, getDbScope(event));
  });
  ipcMain.handle('add-conversation', async (event, message) => {
    const result = await persistMessage(message, null, event);
    windowManager.send('conversation-update');
    return result;
  });
  ipcMain.handle('clear-conversations', async (event) => {
    try {
      if (testClientMode) {
        const sid = ensureTestSession();
        const session = testClientStore.sessions.get(sid);
        session.messages = [];
        chatContextService.invalidate(sid);
        windowManager.send('conversation-update', { sessionId: sid });
        return { cleared: true, sessionId: sid };
      }
      const newSession = await createChatSessionForEvent(null, event);
      chatContextService.invalidate();
      windowManager.send('conversation-update', { sessionId: newSession.id, currentSessionId: newSession.id });
      return { cleared: true, sessionId: newSession.id };
    } catch (error) {
      console.error('Error clearing conversations:', error);
      throw error;
    }
  });
  ipcMain.handle('get-prompt-rules', async (event) => db.getPromptRules(getDbScope(event)));
  ipcMain.handle('get-active-prompt-rules', async (event) => db.getActivePromptRules(getDbScope(event)));
  ipcMain.handle('add-prompt-rule', async (event, rule) => {
    const scopeOptions = getDbScope(event);
    const result = await db.addPromptRule(rule, scopeOptions);
    if (promptFileManager) await promptFileManager.syncToFiles(scopeOptions);
    return result;
  });
  ipcMain.handle('update-prompt-rule', async (event, id, rule) => {
    const scopeOptions = getDbScope(event);
    const result = await db.updatePromptRule(id, rule, scopeOptions);
    if (promptFileManager) await promptFileManager.syncToFiles(scopeOptions);
    return result;
  });
  ipcMain.handle('toggle-prompt-rule', async (event, id, active) => {
    const scopeOptions = getDbScope(event);
    const result = await db.togglePromptRule(id, active, scopeOptions);
    if (promptFileManager) await promptFileManager.syncToFiles(scopeOptions);
    return result;
  });
  ipcMain.handle('delete-prompt-rule', async (event, id) => {
    const scopeOptions = getDbScope(event);
    const result = await db.deletePromptRule(id, scopeOptions);
    if (promptFileManager) await promptFileManager.syncToFiles(scopeOptions);
    return result;
  });
  ipcMain.handle('save-setting', async (event, key, value) => saveGenericSetting(db, key, value, getDbScope(event)));
  async function broadcastExecutionContextUpdate(contextPromise) {
    const context = await contextPromise;
    windowManager.send('execution-context-updated', context);
    return context;
  }
  async function resolveExecutionScope(event, sessionId = null) {
    const requestedSessionId = String(sessionId || '').trim();
    if (!requestedSessionId || !db?.getChatSessionById) {
      return { sessionId: requestedSessionId || null, agentId: null };
    }
    const session = await db.getChatSessionById(requestedSessionId, getDbScope(event)).catch(() => null);
    return {
      sessionId: session?.id ?? requestedSessionId,
      agentId: session?.agent_id ?? null,
      requestContext: getRequestContext(event)
    };
  }
  ipcMain.handle('execution:get-context', async (event, sessionId = null) => {
    if (!executionDirectory?.getContext) {
      return {
        rootPath: process.cwd(),
        configuredRoot: null,
        defaultRoot: process.cwd(),
        source: 'default',
        allowOutsideRoot: true
      };
    }
    return executionDirectory.getContext(await resolveExecutionScope(event, sessionId));
  });
  ipcMain.handle('execution:set-root', async (event, rootPath, sessionId = null) => {
    if (!executionDirectory?.setRoot) {
      return { success: false, error: 'Execution folder service unavailable' };
    }
    const scope = await resolveExecutionScope(event, sessionId);
    return broadcastExecutionContextUpdate(executionDirectory.setRoot(rootPath, scope));
  });
  ipcMain.handle('execution:clear-root', async (event, sessionId = null) => {
    if (!executionDirectory?.clearRoot) {
      return { success: false, error: 'Execution folder service unavailable' };
    }
    const scope = await resolveExecutionScope(event, sessionId);
    return broadcastExecutionContextUpdate(executionDirectory.clearRoot(scope));
  });
  ipcMain.handle('execution:set-allow-outside', async (event, allowOutsideRoot) => {
    if (!executionDirectory?.setAllowOutsideRoot) {
      return { success: false, error: 'Execution folder service unavailable' };
    }
    if (allowOutsideRoot === true && capabilityManager?.setTerminalMode) {
      capabilityManager.setTerminalMode('system');
    }
    return broadcastExecutionContextUpdate(
      executionDirectory.setAllowOutsideRoot(allowOutsideRoot === true)
    );
  });
  ipcMain.handle('create-chat-session', async (event, options = {}) => {
    if ((options?.private === true || privateModeDefault) && privateSessionStore) {
      return privateSessionStore.createSession({ title: options?.title || 'Private Chat' });
    }
    if (testClientMode) {
      const sid = ensureTestSession();
      return { id: sid, title: testClientStore.sessions.get(sid)?.title || 'Test Client' };
    }
    const session = await createChatSessionForEvent(options?.title || null, event);
    if (session?.id) {
      windowManager.send('conversation-update', { sessionId: session.id, currentSessionId: session.id });
    }
    return session;
  });
  ipcMain.handle('get-chat-sessions', async (event, date = null, limit = 6) => {
    if (testClientMode) {
      return Array.from(testClientStore.sessions.values())
        .map(s => ({
          id: s.id,
          title: s.title,
          created_at: s.created_at,
          last_message_at: s.messages.length ? s.messages[s.messages.length - 1].timestamp : s.created_at,
          message_count: s.messages.length,
          first_message: (s.messages.find(m => m.role === 'user') || {}).content || null
        }))
        .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)))
        .slice(0, limit);
    }
    return db.getChatSessions(date, limit, getDbScope(event));
  });
  ipcMain.handle('load-chat-session', async (event, sessionId, options = {}) => {
    if (isPrivateSessionId(sessionId) && privateSessionStore) {
      return privateSessionStore.getMessages(sessionId, 1000);
    }
    if (testClientMode && isTestSessionId(sessionId)) {
      return getTestMessages(sessionId, 1000);
    }
    const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: Boolean(String(sessionId || '').trim()) });
    if (!resolved?.success || !resolved.sessionId) {
      return [];
    }
    return db.loadChatSession(resolved.sessionId, {
      includeHidden: options?.includeHidden === true,
      ...getDbScope(event)
    });
  });
  ipcMain.handle('get-chat-session-meta', async (event, sessionId) => {
    if (isPrivateSessionId(sessionId) && privateSessionStore) {
      const s = privateSessionStore.ensureSession(sessionId);
      return { id: s.id, title: s.title || 'Private Chat', agent_id: null, private: true };
    }
    if (testClientMode && isTestSessionId(sessionId)) return testClientStore.sessions.get(sessionId) || null;
    const row = await getSessionRow(sessionId, event);
    if (row) {
      row.contextUsage = await chatContextService.getProviderContextUsage(row.id);
      if (opencodeRuntimeManager?.getSessionContinuityStatus) {
        row.runtimeContinuity = await opencodeRuntimeManager.getSessionContinuityStatus(row.id, getDbScope(event));
      }
    }
    return row;
  });
  ipcMain.handle('clear-chat-session', async (event, sessionId) => {
    try {
      if (isPrivateSessionId(sessionId) && privateSessionStore) {
        const result = privateSessionStore.clearSession(sessionId);
        chatContextService.invalidate(sessionId);
        windowManager.send('conversation-update', { sessionId });
        return result;
      }
      if (testClientMode && isTestSessionId(sessionId)) {
        const sid = ensureTestSession(sessionId);
        const session = testClientStore.sessions.get(sid);
        if (session) {
          session.messages = [];
        }
        chatContextService.invalidate(sid);
        windowManager.send('conversation-update', { sessionId: sid });
        return { cleared: true, sessionId: sid };
      }
      const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: true });
      if (!resolved?.success || !resolved.sessionId) {
        throw new Error(resolved?.error || `Chat session not found: ${String(sessionId || '').trim()}`);
      }
      await db.clearChatSession(resolved.sessionId, getDbScope(event));
      chatContextService.invalidate(resolved.sessionId);
      await chatContextService.clearProviderContextUsage(resolved.sessionId);
      await chatContextService.clearContextCheckpoint(resolved.sessionId, getDbScope(event));
      windowManager.send('conversation-update', { sessionId: resolved.sessionId });
      return { cleared: true, sessionId: resolved.sessionId };
    } catch (error) {
      console.error('Error clearing chat session:', error);
      throw error;
    }
  });
  ipcMain.handle('switch-chat-session', async (event, sessionId) => {
    try {
      if (isPrivateSessionId(sessionId) && privateSessionStore) {
        privateSessionStore.ensureSession(sessionId);
        if (mcpServer.setCurrentSessionId) {
          mcpServer.setCurrentSessionId(sessionId);
        }
        if (mcpServer.setCurrentAgentContext) {
          mcpServer.setCurrentAgentContext({ sessionId, private: true });
        }
        return { success: true, sessionId, private: true };
      }
      if (testClientMode && isTestSessionId(sessionId)) {
        ensureTestSession(sessionId);
        if (mcpServer.setCurrentSessionId) {
          mcpServer.setCurrentSessionId(sessionId);
        }
        return { success: true, sessionId };
      }
      const requestContext = getRequestContext(event);
      const concurrentRequest = isConcurrentRequestContext(requestContext);
      const prevSession = agentLoop && !concurrentRequest
        ? await getCurrentSessionForEvent(event)
        : null;
      const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: true });
      if (!resolved?.success || !resolved.sessionId) {
        return resolved || { success: false, error: `Chat session not found: ${String(sessionId || '').trim()}` };
      }
      const sessionRow = resolved.session || await getSessionRow(resolved.sessionId, event);
      if (agentLoop && prevSession && prevSession.id !== resolved.sessionId) {
        agentLoop.onSessionClose(prevSession.id).catch(e => console.error('[IPC] Session close error:', e));
      }
      if (!concurrentRequest && mcpServer.setCurrentSessionId) {
        mcpServer.setCurrentSessionId(resolved.sessionId);
      }
      if (!concurrentRequest && mcpServer.setCurrentAgentContext) {
        mcpServer.setCurrentAgentContext(sessionRow?.agent_id ? { sessionId: resolved.sessionId, agentId: sessionRow.agent_id } : null);
      }
      windowManager.send('conversation-update', { sessionId: resolved.sessionId, currentSessionId: resolved.sessionId });
      return { success: true, sessionId: resolved.sessionId };
    } catch (error) {
      console.error('Error switching session:', error);
      throw error;
    }
  });
  ipcMain.handle('delete-chat-session', async (event, sessionId) => {
    try {
      if (isPrivateSessionId(sessionId) && privateSessionStore) {
        const result = privateSessionStore.deleteSession(sessionId);
        chatContextService.invalidate(sessionId);
        windowManager.send('conversation-update');
        return result;
      }
      if (testClientMode && isTestSessionId(sessionId)) {
        testClientStore.sessions.delete(sessionId);
        if (testClientStore.currentSessionId === sessionId) {
          testClientStore.currentSessionId = null;
        }
        chatContextService.invalidate(sessionId);
        windowManager.send('conversation-update');
        return { success: true };
      }
      const requestContext = getRequestContext(event);
      const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: true });
      if (!resolved?.success || !resolved.sessionId) {
        throw new Error(resolved?.error || `Chat session not found: ${String(sessionId || '').trim()}`);
      }
      await db.deleteChatSession(resolved.sessionId, getDbScope(event));
      if (isConcurrentRequestContext(requestContext)) {
        await requestContextService?.clearPreferredSessionId?.(db, requestContext);
      }
      chatContextService.invalidate(resolved.sessionId);
      await chatContextService.clearProviderContextUsage(resolved.sessionId);
      await chatContextService.clearContextCheckpoint(resolved.sessionId, getDbScope(event));
      windowManager.send('conversation-update');
      return { success: true };
    } catch (error) {
      console.error('Error deleting chat session:', error);
      throw error;
    }
  });
  ipcMain.handle('delete-all-conversations', async (event) => {
    try {
      if (testClientMode) {
        testClientStore.sessions.clear();
        testClientStore.currentSessionId = null;
        chatContextService.invalidate();
        windowManager.send('conversation-update');
        return { success: true, message: 'All test conversations deleted' };
      }
      const requestContext = getRequestContext(event);
      await db.deleteAllConversations(getDbScope(event));
      if (isConcurrentRequestContext(requestContext)) {
        await requestContextService?.clearPreferredSessionId?.(db, requestContext);
      }
      chatContextService.invalidate();
      await chatContextService.clearProviderContextUsage();
      windowManager.send('conversation-update');
      return { success: true, message: 'All conversations deleted' };
    } catch (error) {
      console.error('Error deleting all conversations:', error);
      throw error;
    }
  });
  ipcMain.handle('private-session:close-summary', async (event, sessionId) => {
    if (!isPrivateSessionId(sessionId) || !privateSessionStore?.getCloseSummary) {
      return { success: false, error: 'Private session not found' };
    }
    return privateSessionStore.getCloseSummary(sessionId);
  });
  ipcMain.handle('private-session:discard', async (event, sessionId) => {
    if (!isPrivateSessionId(sessionId) || !privateSessionStore?.deleteSession) {
      return { success: false, error: 'Private session not found' };
    }
    agentManager?.subtaskRuntime?.clearPrivateRunsForSession?.(sessionId);
    const result = privateSessionStore.deleteSession(sessionId);
    chatContextService.invalidate(sessionId);
    windowManager.send('conversation-update');
    return result;
  });
  ipcMain.handle('private-session:save', async (event, sessionId, options = {}) => {
    if (!isPrivateSessionId(sessionId) || !privateSessionStore) {
      return { success: false, error: 'Private session not found' };
    }
    const messages = privateSessionStore.getMessages(sessionId, 100000);
    const created = await createChatSessionForEvent(options?.title || 'Saved Private Chat', event);
    const publicSessionId = created?.id;
    for (const message of messages) {
      await db.addConversation({
        role: message.role || 'user',
        content: String(message.content || ''),
        metadata: message.metadata || null
      }, publicSessionId, getDbScope(event));
    }
    if (options?.enqueueMemory !== false && db?.enqueueMemoryJob) {
      await db.enqueueMemoryJob({
        jobType: 'summarize_session',
        sessionId: publicSessionId,
        payload: { source: 'private-session-save', enqueued_at: new Date().toISOString() }
      });
    }
    agentManager?.subtaskRuntime?.clearPrivateRunsForSession?.(sessionId);
    privateSessionStore.deleteSession(sessionId);
    chatContextService.invalidate(sessionId);
    chatContextService.invalidate(publicSessionId);
    windowManager.send('conversation-update');
    return { success: true, publicSessionId, messageCount: messages.length };
  });
  ipcMain.handle('chat-session:import-messages', async (event, sessionId, messages = []) => {
    const safeMessages = Array.isArray(messages) ? messages : [];
    if (isPrivateSessionId(sessionId) && privateSessionStore) {
      privateSessionStore.ensureSession(sessionId); safeMessages.forEach(entry => privateSessionStore.addMessage(sessionId, { role: entry?.role || 'user', content: String(entry?.content || ''), metadata: entry?.metadata || null }));
      chatContextService.invalidate(sessionId); windowManager.send('conversation-update', { sessionId }); return { success: true, sessionId, imported: safeMessages.length, private: true };
    }
    const resolved = await resolveDbBackedSession(sessionId, event, { requireExisting: Boolean(String(sessionId || '').trim()) });
    if (String(sessionId || '').trim() && (!resolved?.success || !resolved.sessionId)) {
      throw new Error(resolved?.error || `Chat session not found: ${String(sessionId || '').trim()}`);
    }
    const targetSessionId = resolved?.success ? resolved.sessionId : sessionId;
    for (const entry of safeMessages) {
      await persistMessage({ role: entry?.role || 'user', content: String(entry?.content || ''), metadata: entry?.metadata || null }, targetSessionId, event);
    }
    windowManager.send('conversation-update', { sessionId: targetSessionId });
    return { success: true, sessionId: targetSessionId, imported: safeMessages.length };
  });
  ipcMain.handle('get-session-artifacts', async (event, sessionId = null) => {
    try {
      const effectiveSessionId = testClientMode ? ensureTestSession(sessionId) : sessionId;
      if (isTestSessionId(effectiveSessionId)) {
        return { success: true, sessionId: effectiveSessionId, files: [], artifacts: [], fileCount: 0 };
      }
      let resolvedSessionId = String(effectiveSessionId || '').trim() || null;
      if (resolvedSessionId) {
        const resolved = await resolveDbBackedSession(resolvedSessionId, event, { requireExisting: true });
        if (!resolved?.success || !resolved.sessionId) {
          return { success: false, error: resolved?.error || `Chat session not found: ${resolvedSessionId}`, sessionId: resolvedSessionId, files: [], artifacts: [], fileCount: 0 };
        }
        resolvedSessionId = resolved.sessionId;
      } else {
        resolvedSessionId = String((await getCurrentSessionForEvent(event))?.id || '').trim() || null;
      }
      if (!resolvedSessionId) {
        return { success: true, sessionId: resolvedSessionId, files: [], artifacts: [], fileCount: 0 };
      }
      if (artifactRegistry) {
        const { artifacts, count } = artifactRegistry.listArtifacts(resolvedSessionId);
        const files = artifacts.map(a => ({
          key: a.key,
          name: a.name,
          size: a.size || 0,
          created: a.timestamp,
          kind: a.kind,
          category: a.category,
          source: a.source,
          action: a.action,
          virtual: a.virtual || false,
          accepted: a.accepted || false,
          data: a.data || null
        }));
        return {
          success: true,
          sessionId: resolvedSessionId,
          files,
          artifacts: files,
          fileCount: count
        };
      }
      if (!sessionWorkspace?.listFiles) {
        return { success: true, sessionId: resolvedSessionId, files: [], artifacts: [], fileCount: 0 };
      }
      const files = sessionWorkspace.listFiles(resolvedSessionId)
        .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
        .map(file => ({
          name: file.name,
          size: file.size,
          created: file.created,
          kind: artifactKindFromExt(file.name)
        }));
      return {
        success: true,
        sessionId: resolvedSessionId,
        files,
        artifacts: files,
        fileCount: files.length
      };
    } catch (error) {
      console.error('Error getting session artifacts:', error);
      return { success: false, error: error.message, files: [], artifacts: [], fileCount: 0 };
    }
  });
  ipcMain.handle('read-session-artifact', async (event, sessionId, artifactRef) => {
    try {
      const effectiveSessionId = testClientMode ? ensureTestSession(sessionId) : sessionId;
      if (isTestSessionId(effectiveSessionId)) {
        return { success: false, error: 'Test sessions do not expose workspace artifacts' };
      }
      if (!effectiveSessionId) {
        return { success: false, error: 'Missing sessionId' };
      }
      if (!(await getSessionRow(effectiveSessionId, event))) {
        return { success: false, error: `Chat session not found: ${String(effectiveSessionId || '').trim()}` };
      }
      if (!sessionWorkspace?.getWorkspacePath) {
        return { success: false, error: 'Session workspace unavailable' };
      }
      const registered = artifactRegistry?.getArtifact?.(effectiveSessionId, artifactRef) || null;
      const rawName = registered?.name || String(artifactRef || '');
      const safeName = path.basename(rawName);
      if (!safeName || safeName !== rawName) return { success: false, error: 'Invalid artifact name' };
      const workspaceDir = sessionWorkspace.getWorkspacePath(effectiveSessionId);
      const artifactPath = registered?.path
        ? path.resolve(registered.path)
        : path.resolve(workspaceDir, safeName);
      if (!registered && !artifactPath.startsWith(path.resolve(workspaceDir) + path.sep)) {
        return { success: false, error: 'Requested artifact is outside workspace' };
      }
      if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { success: false, error: 'Artifact file not found' };
      }
      const stat = fs.statSync(artifactPath);
      const kind = artifactKindFromExt(safeName);
      const maxTextBytes = 1024 * 1024;
      let content = null;
      if (kind === 'text') {
        if (stat.size > maxTextBytes) {
          return {
            success: false,
            error: `Text artifact is too large to open (${Math.round(stat.size / 1024)} KB, max 1024 KB)`
          };
        }
        content = fs.readFileSync(artifactPath, 'utf-8');
      }
      return {
        success: true,
        name: safeName,
        size: stat.size,
        kind,
        path: artifactPath,
        content
      };
    } catch (error) {
      console.error('Error reading session artifact:', error);
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('write-session-artifact', async (event, sessionId, artifactRef, content) => {
    try {
      const effectiveSessionId = testClientMode ? ensureTestSession(sessionId) : sessionId;
      if (isTestSessionId(effectiveSessionId)) {
        return { success: false, error: 'Test sessions do not support artifact writes' };
      }
      if (!effectiveSessionId) {
        return { success: false, error: 'Missing sessionId' };
      }
      if (!(await getSessionRow(effectiveSessionId, event))) {
        return { success: false, error: `Chat session not found: ${String(effectiveSessionId || '').trim()}` };
      }
      if (!sessionWorkspace?.getWorkspacePath) {
        return { success: false, error: 'Session workspace unavailable' };
      }
      const registered = artifactRegistry?.getArtifact?.(effectiveSessionId, artifactRef) || null;
      const rawName = registered?.name || String(artifactRef || '');
      const safeName = path.basename(rawName);
      if (!safeName || safeName !== rawName) {
        return { success: false, error: 'Invalid artifact name' };
      }
      if (artifactKindFromExt(safeName) !== 'text') {
        return { success: false, error: 'Only text artifacts are editable' };
      }
      const workspaceDir = sessionWorkspace.getWorkspacePath(effectiveSessionId);
      const artifactPath = registered?.path ? path.resolve(registered.path) : path.resolve(workspaceDir, safeName);
      if (!registered && !artifactPath.startsWith(path.resolve(workspaceDir) + path.sep)) {
        return { success: false, error: 'Requested artifact is outside workspace' };
      }
      if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { success: false, error: 'Artifact file not found' };
      }
      const normalizedContent = String(content ?? '');
      const maxBytes = 2 * 1024 * 1024;
      if (Buffer.byteLength(normalizedContent, 'utf-8') > maxBytes) {
        return { success: false, error: 'Edited content exceeds 2 MB limit' };
      }
      fs.writeFileSync(artifactPath, normalizedContent, 'utf-8');
      artifactRegistry?.registerFile?.(effectiveSessionId, {
        name: safeName,
        path: artifactPath,
        source: 'artifact_editor',
        action: 'edited'
      });
      windowManager.send('conversation-update', { sessionId: effectiveSessionId });
      return { success: true, name: safeName, size: Buffer.byteLength(normalizedContent, 'utf-8') };
    } catch (error) {
      console.error('Error writing session artifact:', error);
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('accept-artifact', async (event, sessionId, artifactKey) => artifactRegistry
    ? { success: artifactRegistry.acceptArtifact(sessionId, artifactKey) }
    : { success: false, error: 'Artifact registry unavailable' });
  ipcMain.handle('accept-all-artifacts', async (event, sessionId) => artifactRegistry
    ? { success: true, count: artifactRegistry.acceptAllArtifacts(sessionId) }
    : { success: false, error: 'Artifact registry unavailable' });
  ipcMain.handle('clean-artifact', async (event, sessionId, artifactKey) => artifactRegistry
    ? { success: artifactRegistry.cleanArtifact(sessionId, artifactKey) }
    : { success: false, error: 'Artifact registry unavailable' });
  ipcMain.handle('prepare-chat-attachment', async (event, filePath, sessionId = null) => {
    let effectiveSessionId = privateModeDefault && !sessionId
      ? ensurePrivateSession(null)
      : (testClientMode ? ensureTestSession(sessionId) : sessionId);
    if (!isPrivateSessionId(effectiveSessionId) && !isTestSessionId(effectiveSessionId)) {
      const resolved = await resolveInteractiveSession(effectiveSessionId, event);
      if (!resolved?.success || !resolved.sessionId) {
        return { success: false, error: resolved?.error || 'No active session' };
      }
      effectiveSessionId = resolved.sessionId;
    }
    const sourcePath = path.resolve(String(filePath || ''));
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      return { success: false, error: 'Attachment file not found' };
    }
    const stat = fs.statSync(sourcePath);
    if (stat.size > 50 * 1024 * 1024) {
      return { success: false, error: 'Attachment exceeds the 50 MB limit' };
    }
    const root = attachmentRoot(effectiveSessionId);
    fs.mkdirSync(root, { recursive: true });
    const originalName = path.basename(sourcePath);
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'attachment';
    const id = crypto.randomUUID();
    const destination = path.join(root, `${id}-${safeName}`);
    fs.copyFileSync(sourcePath, destination);
    const ext = path.extname(destination).toLowerCase();
    const [type, mimeType] = attachmentTypes.get(ext) || ['document', 'application/octet-stream'];
    return {
      success: true,
      sessionId: effectiveSessionId,
      attachment: { id, name: originalName, path: destination, type, mimeType, size: stat.size }
    };
  });
  ipcMain.handle('send-message', async (event, message, useChaining = true, sessionId = null, requestMeta = null) => {
    let effectiveSessionId = privateModeDefault && !sessionId
      ? ensurePrivateSession(null)
      : (testClientMode ? ensureTestSession(sessionId) : sessionId);
    let resolvedSession = null;
    const requestContext = getRequestContext(event);
    const concurrentRequest = isConcurrentRequestContext(requestContext);
    if (!isPrivateSessionId(effectiveSessionId) && !isTestSessionId(effectiveSessionId)) {
      resolvedSession = await resolveInteractiveSession(effectiveSessionId, event);
      if (!resolvedSession?.success || !resolvedSession.sessionId) {
        throw new Error(resolvedSession?.error || 'No active session');
      }
      effectiveSessionId = resolvedSession.sessionId;
    }
    const isTestSession = isTestSessionId(effectiveSessionId);
    const isPrivateSession = isPrivateSessionId(effectiveSessionId);
    const activitySessionId = effectiveSessionId || 'default';
    const queueKey = `${requestContext?.userId || 'localuser'}:${activitySessionId}`;
    const previousSend = sessionSendQueues.get(queueKey) || Promise.resolve(); let releaseSend;
    const sendGate = new Promise(resolve => { releaseSend = resolve; }); const sendTail = previousSend.catch(() => {}).then(() => sendGate);
    sessionSendQueues.set(queueKey, sendTail); await previousSend.catch(() => {});
    const liveTurn = new LiveTurn({
      windowManager,
      requestId: requestMeta?.requestId,
      sessionId: effectiveSessionId
    });
    const turnEvents = liveTurn.sink();
    const onRetryStatus = (status) => windowManager.send('inference-retry-status', status);
    try {
      if (!isTestSession && !isPrivateSession) markUserActive(activitySessionId, getDbScope(event)?.userId || null);
      liveTurn.emit({ type: 'turn.started' });
      liveTurn.emit({ type: 'status', phase: 'preparing', message: 'Preparing request' });
      const incoming = normalizeIncomingChatMessage(message, effectiveSessionId);
      const displayPrompt = incoming.text || (incoming.attachments.length === 1
        ? 'Review the attached file.'
        : (incoming.attachments.length > 1 ? `Review the ${incoming.attachments.length} attached files.` : ''));
      const effectivePrompt = buildAttachmentPrompt(displayPrompt, incoming.attachments);
      const memoryToken = await memoryRefresh.prepare(effectiveSessionId, { dbQueryOptions: getDbScope(event), requestContext });
      const conversationHistory = await chatContextService.buildPromptHistory(effectiveSessionId, effectivePrompt, {
        dbQueryOptions: getDbScope(event)
      });
      if (!isTestSession && !isPrivateSession && agentLoop) {
        agentLoop.recordActivity(activitySessionId, getDbScope(event));
      }
      if (!isTestSession && !concurrentRequest && mcpServer.setCurrentSessionId) {
        mcpServer.setCurrentSessionId(activitySessionId);
      }
      if (!isTestSession && !isPrivateSession && sessionInitManager) {
        sessionInitManager.recordActivity(getDbScope(event)).catch(() => {});
      }
      await persistMessage({
        role: 'user',
        content: displayPrompt,
        metadata: {
          ...(normalizeClientMessageMetadata(requestMeta) || {}),
          attachments: incoming.attachments
        }
      }, effectiveSessionId, event);
      const sessionRow = !isTestSession && !isPrivateSession
        ? (resolvedSession?.session || await getSessionRow(effectiveSessionId, event))
        : null;
      const agentId = sessionRow ? sessionRow.agent_id : null;
      if (!isTestSession && !concurrentRequest && mcpServer.setCurrentAgentContext) {
        mcpServer.setCurrentAgentContext(agentId ? { sessionId: effectiveSessionId, agentId } : null);
      }
      let response;
      if (chainController && useChaining) {
        console.log('[IPC] Using tool chain controller');
        const trace = {
          onToolQueued(payload) {
            liveTurn.emit({
              type: 'action.started',
              action: { id: payload.toolCallId, kind: 'tool', name: payload.toolName, params: payload.params || {}, status: 'running' }
            });
            windowManager.send('tool-preview-update', {
              ...payload,
              sessionId: effectiveSessionId,
              agentId,
              status: 'queued'
            });
          },
          onToolResult(payload) {
            liveTurn.emit({
              type: 'action.completed',
              action: { id: payload.toolCallId, kind: 'tool', name: payload.toolName, params: payload.params || {}, result: payload.result, error: payload.error || null, status: payload.success ? 'success' : 'error' }
            });
            windowManager.send('tool-preview-update', {
              ...payload,
              sessionId: effectiveSessionId,
              agentId,
              status: payload.success ? 'success' : 'error'
            });
          }
        };
        response = await chainController.executeWithChaining(effectivePrompt, conversationHistory, {
          sessionId: effectiveSessionId,
          agentId,
          attachments: incoming.attachments,
          trace,
          requestContext,
          turnEvents,
          onRetryStatus,
          skipMemoryOnStart: !memoryToken.required
        });
        memoryRefresh.mark(memoryToken);
        if (response && response.needsPermission) {
          windowManager.send('tool-permission-request', { ...response.permissionRequest, sessionId: effectiveSessionId });
          return { needsPermission: true, sessionId: effectiveSessionId, ...response.permissionRequest };
        }
      } else {
        response = await dispatcher.dispatch(effectivePrompt, conversationHistory, {
          mode: 'chat',
          sessionId: effectiveSessionId,
          agentId,
          attachments: incoming.attachments,
          requestContext,
          turnEvents,
          onRetryStatus,
          skipMemoryOnStart: !memoryToken.required
        });
        memoryRefresh.mark(memoryToken);
      }
      if (response?.stopped) {
        liveTurn.emit({ type: 'turn.cancelled' });
        return { ...response, sessionId: effectiveSessionId };
      }
      if (!response || (!String(response.content || '').trim() && !response.stopped)) {
        const error = new Error(`AI provider returned no final response text (request ${liveTurn.requestId})`);
        error.code = 'EMPTY_AI_RESPONSE';
        error.diagnostics = compactResponseDiagnostics(response || {}, liveTurn.requestId);
        throw error;
      }
      const runtimeConfig = await resolveRuntimeForResponse(response);
      const cleanContent = stripToolPatterns(buildAssistantContent(response, runtimeConfig));
      await persistMessage({ role: 'assistant', content: cleanContent, metadata: { diagnostics: compactResponseDiagnostics(response, liveTurn.requestId) } }, effectiveSessionId, event);
      await chatContextService.saveProviderContextUsage(effectiveSessionId, response);
      const { provider: activeProvider, model: activeModel } = await getEffectiveLlmSelection(db);
      if (!isPrivateSession && activeProvider && activeModel) {
        await rememberLastWorkingModel(db, activeProvider, activeModel);
      }
      windowManager.send('conversation-update', { sessionId: effectiveSessionId });
      liveTurn.emit({
        type: response.stopped ? 'turn.cancelled' : 'turn.completed',
        response: { content: cleanContent, reasoning: response.reasoning || '', model: response.model || null, usage: response.usage || null }
      });
      return { ...response, content: cleanContent, sessionId: effectiveSessionId };
    } catch (error) {
      console.error('Error sending message:', error);
      if (error?.code === 'INFERENCE_RETRY_CANCELLED') {
        liveTurn.emit({ type: 'turn.cancelled' });
        return { stopped: true, sessionId: effectiveSessionId };
      }
      if (!isTestSession && !isPrivateSession) await persistResponseError(db, effectiveSessionId, error, liveTurn.requestId, getDbScope(event)).catch(diagnosticError => console.warn('Failed to persist response diagnostics:', diagnosticError.message));
      liveTurn.emit({ type: 'turn.failed', error: error?.message || String(error) });
      throw error;
    } finally {
      releaseSend(); if (sessionSendQueues.get(queueKey) === sendTail) sessionSendQueues.delete(queueKey);
      if (!isTestSession && !isPrivateSession) {
        markUserIdle(activitySessionId, getDbScope(event)?.userId || null);
      }
    }
  });
  ipcMain.handle('confirm-inference-retry', async (_event, requestId) => ({
    confirmed: dispatcher.confirmRetry(requestId)
  }));
  ipcMain.handle('interpret-tool-result', async (event, toolName, params, toolResult, sessionId = null) => {
    let effectiveSessionId = privateModeDefault && !sessionId
      ? ensurePrivateSession(null)
      : (testClientMode ? ensureTestSession(sessionId) : sessionId);
    const requestContext = getRequestContext(event);
    if (!isPrivateSessionId(effectiveSessionId) && !isTestSessionId(effectiveSessionId)) {
      const resolvedSession = await resolveInteractiveSession(effectiveSessionId, event);
      if (!resolvedSession?.success || !resolvedSession.sessionId) {
        throw new Error(resolvedSession?.error || 'No active session');
      }
      effectiveSessionId = resolvedSession.sessionId;
    }
    const isTestSession = isTestSessionId(effectiveSessionId);
    const isPrivateSession = isPrivateSessionId(effectiveSessionId);
    const activitySessionId = effectiveSessionId || 'default';
    if (!isTestSession && !isPrivateSession) {
      markUserActive(activitySessionId, getDbScope(event)?.userId || null);
    }
    try {
      const toolContext = `Tool "${toolName}" was executed with parameters: ${JSON.stringify(params)}
Result: ${JSON.stringify(toolResult, null, 2)}
Based on this tool result, provide a natural, helpful response to the user. Do NOT call any tools.`;
      const conversationHistory = await chatContextService.buildPromptHistory(effectiveSessionId, toolContext, {
        dbQueryOptions: getDbScope(event)
      });
      const response = await dispatcher.dispatch(toolContext, conversationHistory, {
        mode: 'chat',
        sessionId: effectiveSessionId,
        requestContext
      });
      const runtimeConfig = await resolveRuntimeForResponse(response);
      const cleanContent = stripToolPatterns(buildAssistantContent(response, runtimeConfig));
      await persistMessage({ role: 'assistant', content: cleanContent }, effectiveSessionId, event);
      await chatContextService.saveProviderContextUsage(effectiveSessionId, response);
      const { provider: activeProvider, model: activeModel } = await getEffectiveLlmSelection(db);
      if (!isPrivateSession && activeProvider && activeModel) {
        await rememberLastWorkingModel(db, activeProvider, activeModel);
      }
      windowManager.send('conversation-update', { sessionId: effectiveSessionId });
      return { ...response, content: cleanContent, sessionId: effectiveSessionId };
    } catch (error) {
      console.error('Error interpreting tool result:', error);
      return {
        content: `Tool ${toolName} returned: ${JSON.stringify(toolResult, null, 2)}`,
        model: 'fallback'
      };
    } finally {
      if (!isTestSession && !isPrivateSession) {
        markUserIdle(activitySessionId, getDbScope(event)?.userId || null);
      }
    }
  });
  ipcMain.handle('testclient:status', async () => {
    return {
      enabled: testClientMode,
      currentSessionId: testClientStore.currentSessionId,
      sessionCount: testClientStore.sessions.size
    };
  });
  ipcMain.handle('testclient:reset', async () => {
    if (!testClientMode) return { success: false, error: 'Not in --testclient mode' };
    testClientStore.sessions.clear();
    testClientStore.currentSessionId = null;
    chatContextService.invalidate();
    return { success: true };
  });
  ipcMain.handle('path-exists', async (event, filePath) => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_) {
      return false;
    }
  });
  ipcMain.handle('read-file', async (event, filePath) => {
    const fs = require('fs');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  });
}
module.exports = { registerChatDataHandlers };
