// @ts-nocheck
const Database = require('./database');
const AIService = require('./ai-service');
const MCPServer = require('./mcp-server');
const ToolChainController = require('./tool-chain-controller');
const WorkflowManager = require('./workflow-manager');
const WorkflowRuntime = require('./workflow-runtime');
const EmbeddingService = require('./embedding-service');
const VectorStore = require('./vector-store');
const CapabilityManager = require('./capability-manager');
const ToolPermissionStore = require('./tool-permission-store');
const ToolPermissionService = require('./tool-permission-service');
const PortListenerManager = require('./port-listener-manager');
const AgentMemory = require('./agent-memory');
const PromptFileManager = require('./prompt-file-manager');
const AgentLoop = require('./agent-loop');
const ConnectorRuntime = require('./connector-runtime');
const ExternalChannelBridge = require('./external-channel-bridge');
const InferenceDispatcher = require('./inference-dispatcher');
const { CodexRuntimeManager, DEFAULT_PROVIDER_ID: CODEX_PROVIDER_ID } = require('./codex-runtime-manager');
const { OpenCodeRuntimeManager, DEFAULT_PROVIDER_ID: OPENCODE_PROVIDER_ID } = require('./opencode-runtime-manager');
const { A2AManager } = require('./a2a-manager');
const SessionWorkspace = require('./session-workspace');
const AgentManager = require('./agent-manager');
const SubtaskRuntime = require('./subtask-runtime');
const ollamaService = require('./ollama-service');
const BackendEventBus = require('./backend-event-bus');
const BackgroundMemoryDaemon = require('./background-memory-daemon');
const BackgroundWorkflowScheduler = require('./background-workflow-scheduler');
const SessionInitManager = require('./session-init-manager');
const { SetupSuperagentService } = require('./setup-superagent-service');
const { AgentsRoomService } = require('./agents-room-service');
const PluginManager = require('./plugin-manager');
const KnowledgeManager = require('./knowledge-manager');
const ResearchRuntime = require('./research-runtime');
const TaskQueueService = require('./task-queue-service');
const ArtifactRegistry = require('./artifact-registry');
const ArtifactMetadataStore = require('./artifact-metadata-store');
const { TimerManager } = require('./timer-manager');
const { ExecutionDirectory } = require('./execution-directory');
const { CompanionTlsManager } = require('./companion-tls-manager');
const TtsService = require('./tts-service');
const SttService = require('./stt-service');
const { createTtsHttpEntrypoint } = require('./tts-http-entrypoint');
const { createChatContextService } = require('./chat-context-service');
const { SessionCompactionService } = require('./session-compaction-service');
const { stripToolPatterns, stripReasoningBlocks } = require('./ipc/shared-utils');
const { PrivateSessionStore, isPrivateSessionId } = require('./private-session-store');
const { RemoteGatewayManager } = require('./companion/remote-gateway-manager');
const requestContextService = require('./request-context');

export interface BootstrapContext {
  container: any;
  options: any;
  startupProfiler: any;
  paths: any;
  windowManager: any;
  runtimePolicy: any;
  isTestClientMode: boolean;
  isExternalTestMode?: boolean;
  isSkinTestMode?: boolean;
  isNoWindowMode?: boolean;
  privateModeDefault: boolean;
  activeProfile: any;
  profileRegistry: any;
  profileSwitcher: any;
  db?: any;
  eventBus?: any;
  capabilityManager?: any;
  mcpServer?: any;
  aiService?: any;
  dispatcher?: any;
  timerManager?: any;
  chainController?: any;
  workflowManager?: any;
  workflowRuntime?: any;
  agentMemory?: any;
  taskQueueService?: any;
  sessionWorkspace?: any;
  artifactRegistry?: any;
  privateSessionStore?: any;
  chatContextService?: any;
  sessionCompactionService?: any;
  subtaskRuntime?: any;
  promptFileManager?: any;
  agentLoop?: any;
  connectorRuntime?: any;
  externalChannelBridge?: any;
  a2aManager?: any;
  agentManager?: any;
  sessionInitManager?: any;
  setupSuperagentService?: any;
  agentsRoomService?: any;
  pluginManager?: any;
  remoteGatewayManager?: any;
  memoryDaemon?: any;
  workflowScheduler?: any;
  testClientStore?: any;
  userAuth?: any;
  userRegistry?: any;
  [key: string]: any;
}

export function registerOrReplace(container: any, name: string, instance: any): void {
  if (container.has?.(name)) {
    container.replace(name, instance);
    return;
  }
  container.register(name, instance);
}

export async function setupCoreInfrastructure(ctx: BootstrapContext): Promise<void> {
  const {
    container,
    options,
    startupProfiler,
    paths,
    windowManager,
    runtimePolicy,
    isTestClientMode,
    privateModeDefault,
    activeProfile,
    profileRegistry,
    profileSwitcher
  } = ctx;

  registerOrReplace(container, 'runtimePaths', paths);
  registerOrReplace(container, 'windowManager', windowManager);
  registerOrReplace(container, 'startupProfiler', startupProfiler);
  registerOrReplace(container, 'runtimePolicy', runtimePolicy);
  registerOrReplace(container, 'requestContextService', requestContextService);
  registerOrReplace(container, 'activeProfile', activeProfile || null);
  registerOrReplace(container, 'profileRegistry', profileRegistry || null);
  registerOrReplace(container, 'profileSwitcher', profileSwitcher || null);

  const db = new Database({ dbPath: paths.databasePath });
  await startupProfiler.time('database.init', () => db.init());
  container.register('db', db);
  ctx.db = db;

  const companionTlsManager = new CompanionTlsManager(db, paths);
  const executionDirectory = new ExecutionDirectory(db, {
    defaultRoot: options.executionRoot || process.cwd()
  });
  container.register('companionTlsManager', companionTlsManager);
  container.register('executionDirectory', executionDirectory);
  container.register('privateModeDefault', privateModeDefault);
  container.register('testClientMode', isTestClientMode);

  const testClientStore = options.testClientStore || { sessions: new Map(), currentSessionId: null };
  container.register('testClientStore', testClientStore);
  ctx.testClientStore = testClientStore;

  const eventBus = new BackendEventBus({
    notifyPromptPath: paths.backgroundNotifyPromptPath
  });
  container.register('eventBus', eventBus);
  ctx.eventBus = eventBus;

  const capabilityManager = new CapabilityManager(db);
  if (
    await db.getSetting('execution.allowOutsideRoot') === 'true'
    && capabilityManager.getTerminalMode?.() !== 'system'
  ) {
    capabilityManager.setTerminalMode('system');
  }
  container.register('capabilityManager', capabilityManager);
  ctx.capabilityManager = capabilityManager;
}

export async function setupInferenceAndWorkflow(ctx: BootstrapContext): Promise<void> {
  const { container, startupProfiler, db, capabilityManager, windowManager, runtimePolicy, paths, eventBus } = ctx;

  const mcpServer = new MCPServer(db, capabilityManager);
  mcpServer._windowManager = windowManager;
  mcpServer._uiMode = { noWindow: ctx.isNoWindowMode === true };
  mcpServer.setExecutionDirectory(container.get('executionDirectory'));
  mcpServer.setRuntimePolicy(runtimePolicy);
  capabilityManager.registerCustomTool('setup_superagent', true);

  const aiService = new AIService(db, mcpServer, { windowManager });
  await startupProfiler.time('ai.initialize', () => aiService.initialize());
  mcpServer.setAIService(aiService);
  await startupProfiler.time('mcp.customTools.load', () => mcpServer.loadCustomTools());
  container.register('mcpServer', mcpServer);
  container.register('aiService', aiService);
  ctx.mcpServer = mcpServer;
  ctx.aiService = aiService;

  const dispatcher = new InferenceDispatcher(aiService, db, mcpServer);
  container.register('dispatcher', dispatcher);
  ctx.dispatcher = dispatcher;

  const codexRuntimeManager = new CodexRuntimeManager({
    db,
    windowManager,
    executionDirectory: container.get('executionDirectory'),
    runtimePaths: paths,
    dispatcher,
    mcpServer,
    activeProfile: ctx.activeProfile || null
  });
  aiService.setRuntimeProvider(CODEX_PROVIDER_ID, codexRuntimeManager);
  dispatcher.setCodexRuntimeManager(codexRuntimeManager);
  container.register('codexRuntimeManager', codexRuntimeManager);
  ctx.codexRuntimeManager = codexRuntimeManager;

  const opencodeRuntimeManager = new OpenCodeRuntimeManager({
    db,
    windowManager,
    executionDirectory: container.get('executionDirectory'),
    runtimePaths: paths,
    dispatcher,
    activeProfile: ctx.activeProfile || null
  });
  aiService.setRuntimeProvider(OPENCODE_PROVIDER_ID, opencodeRuntimeManager);
  container.register('opencodeRuntimeManager', opencodeRuntimeManager);
  ctx.opencodeRuntimeManager = opencodeRuntimeManager;

  const timerManager = new TimerManager({ db, dispatcher, windowManager });
  mcpServer.setTimerManager(timerManager);
  timerManager.initialize();
  container.register('timerManager', timerManager);
  ctx.timerManager = timerManager;

  const chainController = new ToolChainController(dispatcher, mcpServer, db);
  chainController.setCodexRuntimeManager(codexRuntimeManager);
  timerManager.setChainController(chainController);
  container.register('chainController', chainController);
  ctx.chainController = chainController;

  const workflowManager = new WorkflowManager(db, mcpServer, dispatcher, {
    workflowsDir: paths.workflowBasePath
  });
  const workflowRuntime = new WorkflowRuntime(workflowManager, eventBus, paths.workflowBasePath);
  workflowRuntime.initialize();
  workflowManager.setWorkflowRuntime(workflowRuntime);
  chainController.setWorkflowManager(workflowManager);
  mcpServer.setWorkflowManager(workflowManager);
  container.register('workflowManager', workflowManager);
  container.register('workflowRuntime', workflowRuntime);
  ctx.workflowManager = workflowManager;
  ctx.workflowRuntime = workflowRuntime;

  const embeddingService = new EmbeddingService();
  const vectorStore = new VectorStore(db, embeddingService);
  container.register('embeddingService', embeddingService);
  container.register('vectorStore', vectorStore);

  const portListenerManager = new PortListenerManager(dispatcher);
  const agentMemory = new AgentMemory(paths.memoryBasePath);
  container.register('portListenerManager', portListenerManager);
  container.register('agentMemory', agentMemory);
  ctx.agentMemory = agentMemory;
}

function createBootstrapTestHelpers(ctx: BootstrapContext): { ensureBootstrapTestSession: (sessionId?: string | null) => string; getBootstrapTestMessages: (sessionId: string, limit?: number) => any[] } {
  function isTestSessionId(sessionId: string): boolean {
    return typeof sessionId === 'string' && sessionId.startsWith('testclient-');
  }

  function ensureBootstrapTestSession(sessionId: string | null = null): string {
    if (!ctx.isTestClientMode) return sessionId!;
    if (sessionId && isTestSessionId(sessionId)) {
      if (!ctx.testClientStore.sessions.has(sessionId)) {
        ctx.testClientStore.sessions.set(sessionId, {
          id: sessionId,
          title: 'Test Client',
          created_at: new Date().toISOString(),
          messages: []
        });
      }
      ctx.testClientStore.currentSessionId = sessionId;
      return sessionId;
    }
    if (ctx.testClientStore.currentSessionId && ctx.testClientStore.sessions.has(ctx.testClientStore.currentSessionId)) {
      return ctx.testClientStore.currentSessionId;
    }
    const id = `testclient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ctx.testClientStore.sessions.set(id, {
      id,
      title: `Test Chat ${new Date().toLocaleTimeString()}`,
      created_at: new Date().toISOString(),
      messages: []
    });
    ctx.testClientStore.currentSessionId = id;
    return id;
  }

  function getBootstrapTestMessages(sessionId: string, limit: number = 100): any[] {
    const sid = ensureBootstrapTestSession(sessionId);
    const session = ctx.testClientStore.sessions.get(sid);
    if (!session) return [];
    return session.messages
      .slice(-limit)
      .map((message: any) => ({ ...message, timestamp: message.timestamp || new Date().toISOString() }));
  }

  return { ensureBootstrapTestSession, getBootstrapTestMessages };
}

export async function setupSessionRuntime(ctx: BootstrapContext): Promise<void> {
  const { container, startupProfiler, db, dispatcher, eventBus, paths, windowManager, agentMemory } = ctx;

  const taskQueueService = new TaskQueueService({
    db,
    tasksFilePath: paths.tasksQueueFile,
    agentinRoot: paths.agentinRoot,
    getActiveUserId: () => ctx.userAuth?.getActiveUser?.()?.userId || 'localuser',
    onQueueUpdated(payload: any) {
      windowManager.send('task-queue-update', payload || {});
    }
  });
  await startupProfiler.time('taskQueue.initialize', () => taskQueueService.initialize());
  container.register('taskQueueService', taskQueueService);
  ctx.taskQueueService = taskQueueService;

  const sessionWorkspace = new SessionWorkspace({
    basePath: paths.sessionWorkspaceBase,
    agentinRoot: paths.agentinRoot,
    db,
    getActiveUserId: () => ctx.userAuth?.getActiveUser?.()?.userId || 'localuser'
  });
  sessionWorkspace.cleanupStale(30);
  const artifactRegistry = new ArtifactRegistry(sessionWorkspace, {
    storage: new ArtifactMetadataStore(db),
    onUpdate(sessionId: string) {
      windowManager.send('artifact-update', { sessionId });
    }
  });
  const privateSessionStore = new PrivateSessionStore({ sessionWorkspace });
  container.register('sessionWorkspace', sessionWorkspace);
  container.register('artifactRegistry', artifactRegistry);
  container.register('privateSessionStore', privateSessionStore);
  ctx.sessionWorkspace = sessionWorkspace;
  ctx.artifactRegistry = artifactRegistry;
  ctx.privateSessionStore = privateSessionStore;

  const { getBootstrapTestMessages } = createBootstrapTestHelpers(ctx);
  const chatContextService = createChatContextService({
    db,
    dispatcher,
    privateSessionStore,
    testClientMode: ctx.isTestClientMode,
    testClientStore: ctx.testClientStore,
    getTestMessages: getBootstrapTestMessages,
    cleaners: { stripToolPatterns, stripReasoningBlocks }
  });
  container.register('chatContextService', chatContextService);
  if (ctx.timerManager?.setChatContextService) {
    ctx.timerManager.setChatContextService(chatContextService);
  }
  ctx.chatContextService = chatContextService;

  const sessionCompactionService = new SessionCompactionService({
    db,
    dispatcher,
    aiService: ctx.aiService,
    chatContextService,
    windowManager
  });
  container.register('sessionCompactionService', sessionCompactionService);
  ctx.sessionCompactionService = sessionCompactionService;

  const persistConversationMessage = async (message: any, sessionId: string | null = null) => {
    let result;
    if (privateSessionStore && isPrivateSessionId(sessionId)) {
      result = privateSessionStore.addMessage(sessionId, message);
      chatContextService.append(sessionId, message);
      return result;
    }

    const isTestSession = typeof sessionId === 'string' && sessionId.startsWith('testclient-');
    if (ctx.isTestClientMode && isTestSession) {
      if (!ctx.testClientStore.sessions.has(sessionId)) {
        ctx.testClientStore.sessions.set(sessionId, {
          id: sessionId,
          title: 'Test Client',
          created_at: new Date().toISOString(),
          messages: []
        });
      }
      const session = ctx.testClientStore.sessions.get(sessionId);
      session.messages.push({
        role: message.role,
        content: message.content,
        metadata: message.metadata || null,
        timestamp: new Date().toISOString()
      });
      ctx.testClientStore.currentSessionId = sessionId;
      chatContextService.append(sessionId, message);
      return message;
    }

    result = await db.addConversation(message, sessionId);
    chatContextService.append(sessionId, message);
    return result;
  };

  const subtaskRuntime = new SubtaskRuntime(db, sessionWorkspace, eventBus, paths.subtaskBasePath, {
    persistConversationMessage,
    notifyConversationUpdate(sessionId: string | null) {
      if (sessionId === null || sessionId === undefined) {
        return windowManager.send('conversation-update');
      }
      return windowManager.send('conversation-update', { sessionId });
    }
  });
  container.register('subtaskRuntime', subtaskRuntime);
  ctx.subtaskRuntime = subtaskRuntime;

  const promptFileManager = new PromptFileManager(db, paths.promptBasePath);
  dispatcher.setPromptFileManager(promptFileManager);
  await startupProfiler.time('prompt.initialize', () => promptFileManager.initialize());
  const systemPrompt = await startupProfiler.time('prompt.loadSystem', () => promptFileManager.loadSystemPrompt());
  await startupProfiler.time('ai.setSystemPrompt', () => ctx.aiService.setSystemPrompt(systemPrompt));
  ctx.mcpServer.setPromptFileManager(promptFileManager);
  container.register('promptFileManager', promptFileManager);
  ctx.promptFileManager = promptFileManager;

  const agentLoop = new AgentLoop(dispatcher, agentMemory, db, sessionWorkspace, {
    templateBasePath: paths.promptTemplatesDir,
    userProfilePath: paths.userProfilePath,
    taskQueueService
  });
  ctx.mcpServer.setAgentLoop(agentLoop);
  ctx.mcpServer.setSessionWorkspace(sessionWorkspace);
  ctx.mcpServer.setArtifactRegistry(artifactRegistry);
  container.register('agentLoop', agentLoop);
  ctx.agentLoop = agentLoop;

  const connectorRuntime = new ConnectorRuntime(dispatcher, db, {
    connectorsDir: paths.connectorsDir,
    eventBus,
    externalChannelBridge: new ExternalChannelBridge({
      db,
      dispatcher,
      chainController: ctx.chainController,
      windowManager,
      aiService: ctx.aiService,
      chatContextService,
      sessionCompactionService
    })
  });
  const externalChannelBridge = connectorRuntime.externalChannelBridge;
  ctx.mcpServer.setConnectorRuntime(connectorRuntime);
  container.register('connectorRuntime', connectorRuntime);
  ctx.connectorRuntime = connectorRuntime;
  ctx.externalChannelBridge = externalChannelBridge;

  const a2aManager = new A2AManager({
    db,
    aiService: ctx.aiService,
    dispatcher,
    externalChannelBridge,
    windowManager,
    container,
    userAuth: ctx.userAuth || container.optional?.('userAuth') || null,
    baseDir: paths.a2aBaseDir,
    targetsDir: paths.a2aTargetsDir,
    tasksDir: paths.a2aTasksDir,
    eventsDir: paths.a2aEventsDir
  });
  await startupProfiler.time('a2a.initialize', () => a2aManager.initialize());
  ctx.mcpServer.setA2AManager(a2aManager);
  container.register('a2aManager', a2aManager);
  ctx.a2aManager = a2aManager;
}

export async function setupAgentAndPluginRuntime(ctx: BootstrapContext): Promise<void> {
  const { container, startupProfiler, db, dispatcher, agentMemory, sessionWorkspace, eventBus, subtaskRuntime, paths, windowManager, taskQueueService } = ctx;

  const agentManager = new AgentManager(
    db,
    dispatcher,
    ctx.agentLoop,
    agentMemory,
    sessionWorkspace,
    ctx.chainController,
    eventBus,
    subtaskRuntime,
    { basePath: paths.agentBasePath, userRegistry: ctx.userRegistry || container.optional?.('userRegistry') || null }
  );
  await startupProfiler.time('agentManager.initialize', () => agentManager.initialize());
  dispatcher.setAgentManager(agentManager);
  ctx.codexRuntimeManager?.setAgentManager?.(agentManager);
  ctx.mcpServer.setAgentManager(agentManager);
  container.register('agentManager', agentManager);
  ctx.agentManager = agentManager;

  const toolPermissionStore = new ToolPermissionStore(db);
  const toolPermissionService = new ToolPermissionService({
    db,
    capabilityManager: ctx.capabilityManager,
    mcpServer: ctx.mcpServer,
    agentManager,
    store: toolPermissionStore
  });
  await startupProfiler.time('toolPermission.initialize', () => toolPermissionService.initialize());
  ctx.mcpServer.setToolPermissionService(toolPermissionService);
  agentManager.setToolPermissionService(toolPermissionService);
  container.register('toolPermissionStore', toolPermissionStore);
  container.register('toolPermissionService', toolPermissionService);

  const sessionInitManager = new SessionInitManager(db, agentMemory, eventBus, {
    agentinPath: paths.agentinRoot,
    templatePath: paths.coldStartTemplatePath,
    connectorsDir: paths.connectorsDir,
    userProfilePath: paths.userProfilePath,
    memoryBasePath: paths.memoryBasePath
  });
  const setupSuperagentService = new SetupSuperagentService(container, {
    db,
    sessionInitManager,
    capabilityManager: ctx.capabilityManager,
    windowManager,
    eventBus
  });
  const agentsRoomService = new AgentsRoomService(container, {
    db,
    agentManager,
    dispatcher,
    chainController: ctx.chainController,
    windowManager
  });
  container.register('sessionInitManager', sessionInitManager);
  container.register('setupSuperagentService', setupSuperagentService);
  container.register('agentsRoomService', agentsRoomService);
  ctx.sessionInitManager = sessionInitManager;
  ctx.setupSuperagentService = setupSuperagentService;
  ctx.agentsRoomService = agentsRoomService;

  const pluginManager = new PluginManager(container, { pluginsDir: paths.pluginsDir });
  container.register('pluginManager', pluginManager);
  await startupProfiler.time('plugin.initialize', () => pluginManager.initialize({ autoEnablePersisted: false }));
  agentManager.setPluginManager(pluginManager);
  await startupProfiler.time('agentPlugins.sync', () => agentManager.syncDefaultAgentPlugins(pluginManager));
  ctx.mcpServer._setupSuperagentService = setupSuperagentService;
  ctx.pluginManager = pluginManager;

  const ttsService = new TtsService({ db, pluginManager, agentManager });
  const sttService = new SttService({ db, runtimePaths: paths, pluginManager });
  const remoteGatewayManager = new RemoteGatewayManager({
    db,
    getCompanionServer: () => container.optional('companionServer')
  });

  container.register('ttsService', ttsService);
  container.register('sttService', sttService);
  container.register('ttsHttpEntrypoint', createTtsHttpEntrypoint({
    getTtsService: () => container.optional('ttsService')
  }));
  container.register('remoteGatewayManager', remoteGatewayManager);
  ctx.remoteGatewayManager = remoteGatewayManager;

  const memoryDaemon = new BackgroundMemoryDaemon(dispatcher, agentMemory, db, eventBus, {
    basePath: paths.backgroundDaemonBasePath,
    userProfilePath: paths.userProfilePath,
    taskQueueService
  });
  const workflowScheduler = new BackgroundWorkflowScheduler(ctx.workflowManager, db, eventBus);
  container.register('memoryDaemon', memoryDaemon);
  container.register('workflowScheduler', workflowScheduler);
  container.register('ollamaService', ollamaService);
  ctx.memoryDaemon = memoryDaemon;
  ctx.workflowScheduler = workflowScheduler;
}

export async function setupBackgroundAndKnowledgeRuntime(ctx: BootstrapContext): Promise<void> {
  const { container, startupProfiler, db, paths, eventBus } = ctx;

  const knowledgeManager = new KnowledgeManager(db, { baseDir: paths.knowledgeBaseDir });
  container.register('knowledgeManager', knowledgeManager);
  await startupProfiler.time('knowledge.initialize', () => knowledgeManager.initialize());
  ctx.mcpServer.setKnowledgeManager(knowledgeManager);
  ctx.memoryDaemon.setKnowledgeManager(knowledgeManager);

  const researchRuntime = new ResearchRuntime(
    ctx.workflowManager,
    knowledgeManager,
    eventBus,
    paths.researchBasePath
  );
  researchRuntime.initialize();
  ctx.mcpServer.setResearchRuntime(researchRuntime);
  container.register('researchRuntime', researchRuntime);

  ctx.mcpServer.registerTool('explore_knowledge', {
    name: 'explore_knowledge',
    description: 'Get the knowledge file tree. Returns all knowledge items with metadata (titles, categories, tags, file paths, line counts). Use read_file to access specific knowledge content after exploring.',
    userDescription: 'Explore the personal knowledge store',
    inputSchema: { type: 'object' }
  }, async () => knowledgeManager.getKnowledgeTree());
  ctx.capabilityManager.registerCustomTool('explore_knowledge', true);
}
