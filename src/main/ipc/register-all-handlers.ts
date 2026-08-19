// @ts-nocheck
const { registerLlmHandlers } = require('./register-llm-handlers');
const { registerChatDataHandlers } = require('./register-chat-data-handlers');
const { registerToolsCapabilityHandlers } = require('./register-tools-capability-handlers');
const { registerWorkflowHandlers } = require('./register-workflow-handlers');
const { registerAgentSystemHandlers } = require('./register-agent-system-handlers');
const { registerSetupSuperagentHandlers } = require('./register-setup-superagent-handlers');
const { registerPluginKnowledgeHandlers } = require('./register-plugin-knowledge-handlers');
const { registerDialogHandlers } = require('./register-dialog-handlers');
const { registerSttHandlers } = require('./register-stt-handlers');
const { registerTtsHandlers } = require('./register-tts-handlers');
const { registerAppControlHandlers } = require('./register-app-control-handlers');
const { createPolicyIpcMain } = require('./runtime-policy-ipc');
const {
  buildAgentRuntime,
  buildAppControlRuntime,
  buildChatRuntime,
  buildLlmRuntime,
  buildMediaRuntime,
  buildPluginKnowledgeRuntime,
  buildSharedRuntime,
  buildToolsRuntime,
  buildWorkflowRuntime
} = require('./runtime-dependencies');

function registerAllHandlers(ipcMain, container) {
  const sharedRuntime = buildSharedRuntime(container);
  const policyIpcMain = createPolicyIpcMain(ipcMain, sharedRuntime);
  const { db, eventBus, memoryDaemon, workflowScheduler, sessionInitManager } = sharedRuntime;

  const configuredDebounceMs = Number(sharedRuntime.userIdleDebounceMs);
  const USER_IDLE_DEBOUNCE_MS = Number.isFinite(configuredDebounceMs) && configuredDebounceMs >= 0
    ? configuredDebounceMs
    : 20 * 1000;
  let activeUserRequests = 0;
  let userIdleTimer = null;

  function markUserActive(sessionId = null, userId = null) {
    if (!eventBus) return;

    if (userIdleTimer) {
      clearTimeout(userIdleTimer);
      userIdleTimer = null;
    }

    activeUserRequests += 1;
    if (activeUserRequests === 1) {
      eventBus.publish('chat:user-active', { sessionId, userId });
    }
  }

  function markUserIdle(sessionId = null, userId = null) {
    if (!eventBus) return;

    activeUserRequests = Math.max(0, activeUserRequests - 1);
    if (activeUserRequests > 0) return;

    if (userIdleTimer) {
      clearTimeout(userIdleTimer);
    }

    userIdleTimer = setTimeout(() => {
      if (activeUserRequests === 0) {
        eventBus.publish('chat:user-idle', { sessionId, userId });
      }
    }, USER_IDLE_DEBOUNCE_MS);
    if (typeof userIdleTimer.unref === 'function') {
      userIdleTimer.unref();
    }
  }

  async function syncDaemonEnabledSetting(options = {}) {
    const enabled = Boolean((memoryDaemon && memoryDaemon.running) || (workflowScheduler && workflowScheduler.running));
    if (sessionInitManager?.saveScopedSetting) {
      await sessionInitManager.saveScopedSetting('baseinit.daemonEnabled', enabled ? 'true' : 'false', options);
      return;
    }
    await db.saveSetting('baseinit.daemonEnabled', enabled ? 'true' : 'false');
  }

  registerLlmHandlers(policyIpcMain, buildLlmRuntime(sharedRuntime));
  registerChatDataHandlers(policyIpcMain, buildChatRuntime(sharedRuntime), { markUserActive, markUserIdle });
  registerToolsCapabilityHandlers(policyIpcMain, buildToolsRuntime(sharedRuntime));
  registerWorkflowHandlers(policyIpcMain, buildWorkflowRuntime(sharedRuntime));
  registerAgentSystemHandlers(policyIpcMain, buildAgentRuntime(sharedRuntime), { syncDaemonEnabledSetting });
  registerSetupSuperagentHandlers(policyIpcMain, buildAgentRuntime(sharedRuntime));
  registerPluginKnowledgeHandlers(policyIpcMain, buildPluginKnowledgeRuntime(sharedRuntime));
  registerDialogHandlers(policyIpcMain, buildChatRuntime(sharedRuntime));
  registerSttHandlers(policyIpcMain, buildMediaRuntime(sharedRuntime));
  registerTtsHandlers(policyIpcMain, buildMediaRuntime(sharedRuntime));
  registerAppControlHandlers(policyIpcMain, buildAppControlRuntime(sharedRuntime));
}

module.exports = { registerAllHandlers };



