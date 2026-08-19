// @ts-nocheck
const { createStaticWindowManager } = require('../window-manager');

function pick(container, names) {
  return names.reduce((acc, name) => {
    if (container.has?.(name)) {
      acc[name] = container.get(name);
    } else {
      acc[name] = container.optional?.(name);
    }
    return acc;
  }, {});
}

function buildSharedRuntime(container) {
  const picked = pick(container, [
    'db',
    'aiService',
    'codexRuntimeManager',
    'opencodeRuntimeManager',
    'mcpServer',
    'chainController',
    'workflowManager',
    'vectorStore',
    'capabilityManager',
    'toolPermissionService',
    'runtimePolicy',
    'portListenerManager',
    'agentMemory',
    'promptFileManager',
    'agentLoop',
    'connectorRuntime',
    'a2aManager',
    'sessionWorkspace',
    'executionDirectory',
    'privateSessionStore',
    'chatContextService',
    'sessionCompactionService',
    'dispatcher',
    'agentManager',
    'companionTlsManager',
    'pluginManager',
    'taskQueueService',
    'eventBus',
    'memoryDaemon',
    'workflowScheduler',
    'sessionInitManager',
    'localShardProcessManager',
    'shardRegistry',
    'shardSupervisor',
    'setupSuperagentService',
    'artifactRegistry',
    'knowledgeManager',
    'runtimePaths',
    'ollamaService',
    'windowManager',
    'requestContextService',
    'profileRegistry',
    'profileSwitcher',
    'activeProfile',
    'userRegistry',
    'userAuth',
    'activeUser',
    'agentBundleLoader',
    'runtimeUiContext'
  ]);

  return {
    container,
    ...picked,
    windowManager: picked.windowManager || createStaticWindowManager(container.optional('mainWindow')),
    privateModeDefault: container.optional('privateModeDefault') === true,
    testClientMode: container.optional('testClientMode') === true,
    testClientStore: container.optional('testClientStore') || { sessions: new Map(), currentSessionId: null },
    userIdleDebounceMs: container.optional('userIdleDebounceMs')
  };
}

function buildLlmRuntime(shared) {
  return {
    container: shared.container,
    db: shared.db,
    aiService: shared.aiService,
    codexRuntimeManager: shared.codexRuntimeManager,
    opencodeRuntimeManager: shared.opencodeRuntimeManager,
    promptFileManager: shared.promptFileManager,
    dispatcher: shared.dispatcher,
    runtimePolicy: shared.runtimePolicy,
    windowManager: shared.windowManager,
    chainController: shared.chainController
  };
}

function buildChatRuntime(shared) {
  return {
    db: shared.db,
    mcpServer: shared.mcpServer,
    windowManager: shared.windowManager,
    chainController: shared.chainController,
    agentLoop: shared.agentLoop,
    agentManager: shared.agentManager,
    dispatcher: shared.dispatcher,
    sessionWorkspace: shared.sessionWorkspace,
    sessionInitManager: shared.sessionInitManager,
    promptFileManager: shared.promptFileManager,
    memoryDaemon: shared.memoryDaemon,
    taskQueueService: shared.taskQueueService,
    executionDirectory: shared.executionDirectory,
    capabilityManager: shared.capabilityManager,
    privateSessionStore: shared.privateSessionStore,
    privateModeDefault: shared.privateModeDefault,
    testClientMode: shared.testClientMode,
    testClientStore: shared.testClientStore,
    artifactRegistry: shared.artifactRegistry,
    chatContextService: shared.chatContextService,
    sessionCompactionService: shared.sessionCompactionService,
    requestContextService: shared.requestContextService,
    opencodeRuntimeManager: shared.opencodeRuntimeManager
  };
}

function buildToolsRuntime(shared) {
  return {
    db: shared.db,
    capabilityManager: shared.capabilityManager,
    mcpServer: shared.mcpServer,
    windowManager: shared.windowManager,
    chainController: shared.chainController,
    dispatcher: shared.dispatcher,
    toolPermissionService: shared.toolPermissionService,
    runtimePolicy: shared.runtimePolicy,
    executionDirectory: shared.executionDirectory,
    requestContextService: shared.requestContextService,
    agentManager: shared.agentManager
  };
}

function buildWorkflowRuntime(shared) {
  return {
    db: shared.db,
    aiService: shared.aiService,
    workflowManager: shared.workflowManager,
    windowManager: shared.windowManager,
    dispatcher: shared.dispatcher,
    mcpServer: shared.mcpServer,
    agentManager: shared.agentManager,
    sessionWorkspace: shared.sessionWorkspace
  };
}

function buildAgentRuntime(shared) {
  return {
    container: shared.container,
    mcpServer: shared.mcpServer,
    aiService: shared.aiService,
    portListenerManager: shared.portListenerManager,
    agentMemory: shared.agentMemory,
    connectorRuntime: shared.connectorRuntime,
    agentManager: shared.agentManager,
    agentLoop: shared.agentLoop,
    sessionInitManager: shared.sessionInitManager,
    setupSuperagentService: shared.setupSuperagentService,
    pluginManager: shared.pluginManager,
    db: shared.db,
    eventBus: shared.eventBus,
    windowManager: shared.windowManager,
    chainController: shared.chainController,
    memoryDaemon: shared.memoryDaemon,
    workflowScheduler: shared.workflowScheduler,
    a2aManager: shared.a2aManager,
    testClientMode: shared.testClientMode,
    toolPermissionService: shared.toolPermissionService,
    companionTlsManager: shared.companionTlsManager,
    agentBundleLoader: shared.agentBundleLoader,
    localShardProcessManager: shared.localShardProcessManager,
    shardRegistry: shared.shardRegistry,
    shardSupervisor: shared.shardSupervisor
  };
}

function buildPluginKnowledgeRuntime(shared) {
  return {
    container: shared.container,
    pluginManager: shared.pluginManager,
    agentManager: shared.agentManager,
    mcpServer: shared.mcpServer,
    db: shared.db,
    windowManager: shared.windowManager,
    runtimePaths: shared.runtimePaths,
    knowledgeManager: shared.knowledgeManager
  };
}

function buildMediaRuntime(shared) {
  return {
    container: shared.container,
    db: shared.db,
    pluginManager: shared.pluginManager,
    agentManager: shared.agentManager,
    companionTlsManager: shared.companionTlsManager,
    runtimePaths: shared.runtimePaths
  };
}

function buildAppControlRuntime(shared) {
  return {
    windowManager: shared.windowManager,
    eventBus: shared.eventBus,
    db: shared.db,
    agentManager: shared.agentManager,
    sessionWorkspace: shared.sessionWorkspace,
    executionDirectory: shared.executionDirectory,
    requestContextService: shared.requestContextService,
    runtimePaths: shared.runtimePaths,
    profileRegistry: shared.profileRegistry,
    profileSwitcher: shared.profileSwitcher,
    activeProfile: shared.activeProfile,
    userRegistry: shared.userRegistry,
    userAuth: shared.userAuth,
    activeUser: shared.activeUser,
    runtimeUiContext: shared.runtimeUiContext,
    localShardProcessManager: shared.localShardProcessManager,
    shardRegistry: shared.shardRegistry,
    shardSupervisor: shared.shardSupervisor
  };
}

module.exports = {
  buildAgentRuntime,
  buildAppControlRuntime,
  buildChatRuntime,
  buildLlmRuntime,
  buildMediaRuntime,
  buildPluginKnowledgeRuntime,
  buildSharedRuntime,
  buildToolsRuntime,
  buildWorkflowRuntime
};
