// @ts-nocheck
(function bootstrapCompanionUpdates(global) {
  async function handleConversationUpdate(app, payload = {}) {
    const sessionId = String(payload.sessionId || '').trim();
    const currentSessionId = String(payload.currentSessionId || '').trim();
    const payloadDeviceId = String(payload.deviceId || '').trim();
    const appDeviceId = String(app?.client?.deviceId || '').trim();
    const isLocalCurrentSessionUpdate = !payloadDeviceId || !appDeviceId || payloadDeviceId === appDeviceId;
    if (currentSessionId && isLocalCurrentSessionUpdate) {
      app.activeSessionId = currentSessionId;
      app.changedSessionIds.delete(currentSessionId);
      await Promise.all([
        app.loadSessions(),
        app.loadMessages(),
        app.loadArtifacts()
      ]);
      app.renderSessions();
      return;
    }
    if (sessionId && app.activeSessionId && sessionId !== String(app.activeSessionId)) {
      app.changedSessionIds.add(sessionId);
      await app.loadSessions();
      app.renderSessions();
      return;
    }

    await Promise.all([
      app.loadSessions(),
      app.activeSessionId ? app.loadMessages() : Promise.resolve(),
      app.activeSessionId ? app.loadArtifacts() : Promise.resolve()
    ]);
  }

  async function resyncVisibleState(app) {
    if (app.ui.appShell.hidden) return;
    await Promise.all([
      app.refreshSnapshot(),
      app.loadSessions(),
      app.loadAgents(),
      app.activity && app.activity.loadTaskQueue ? app.activity.loadTaskQueue() : Promise.resolve(),
      app.activeSessionId ? app.loadMessages() : Promise.resolve(),
      app.activeSessionId ? app.loadArtifacts() : Promise.resolve()
    ]);
  }

  async function resyncAfterReconnect(app) {
    if (app.resyncInFlight || app.ui.appShell.hidden) return app.resyncInFlight;
    app.resyncInFlight = resyncVisibleState(app)
      .catch((error) => app.showToast(error.message || 'Failed to resync companion state', 'error'))
      .finally(() => {
        app.resyncInFlight = null;
      });
    return app.resyncInFlight;
  }

  function createUpdateHandlers(app) {
    const record = (type, payload) => {
      if (app.activity && app.activity.recordEvent) app.activity.recordEvent(type, payload || {});
    };
    const refreshSnapshot = (payload, message) => {
      record((message && message.type) || 'settings-change', payload);
      return app.refreshSnapshot();
    };
    return {
      'conversation-update': (payload) => {
        record('conversation-update', payload);
        return handleConversationUpdate(app, payload);
      },
      'agent-update': (payload) => {
        record('agent-update', payload);
        return app.loadAgents();
      },
      'capability-update': refreshSnapshot,
      'settings-change': refreshSnapshot,
      'workflow-update': refreshSnapshot,
      'task-queue-update': (payload) => {
        record('task-queue-update', payload);
        return app.activity && app.activity.loadTaskQueue ? app.activity.loadTaskQueue() : undefined;
      },
      'calendar-update': refreshSnapshot,
      'todo-update': refreshSnapshot,
      'tool-update': refreshSnapshot,
      'execution-context-updated': refreshSnapshot,
      'plugins:state-changed': refreshSnapshot,
      'a2a-status-update': refreshSnapshot,
      'background-event': refreshSnapshot,
      'permissions-update': (payload) => {
        record('permissions-update', payload);
        return resyncVisibleState(app);
      },
      'tool-permission-request': (payload = {}) => {
        const text = String(payload.toolName || payload.name || payload.message || 'Tool permission requested on desktop').trim();
        if (app.activity && app.activity.addPermissionRequest) app.activity.addPermissionRequest(payload);
        record('tool-permission-request', payload);
        app.showToast(text, 'info');
      },
      'background-notification': (payload = {}) => {
        const text = String(payload.message || payload.summary || 'Background notification').trim();
        record('background-notification', payload);
        if (text) app.showToast(text, 'info');
      },
      'device-kicked': () => {
        app.showToast('This device was disconnected from the desktop app.', 'error');
        app.logout();
      }
    };
  }

  global.LocalAgentCompanionUpdates = {
    createUpdateHandlers,
    resyncAfterReconnect
  };
})(window);
