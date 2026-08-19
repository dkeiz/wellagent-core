const ServiceContainer = require('./service-container');
const CompanionApiServer = require('./companion/companion-api-server');
const { configureCompanionServer, attachCompanionRelays } = require('./companion/companion-backend-dispatch');

const { resolveEasyConnectHost } = require('./companion-network-utils');
const setupIpcHandlers = require('./ipc-handlers');
const { WindowManager } = require('./window-manager');
const { buildRuntimePaths } = require('./runtime-paths');
const { createStartupProfiler } = require('./startup-profiler');
const { RuntimePolicy } = require('./runtime-policy');
const { createProfileSwitcher } = require('./profile-switcher');
const { createProfileRegistry } = require('./profile-registry');
const { runLegacyAppDataMigration } = require('./legacy-appdata-migration');
const { createUserRegistry } = require('./user-registry');
const { createUserAuth } = require('./user-auth');
const { createDeferredRuntimeStartup, scheduleNamedStartup } = require('./bootstrap-lifecycle');
const { createAgentBundleLoader } = require('./agent-bundle-loader');
const { createCoreApi } = require('./core-api');
const { createShardRegistry } = require('./shard-registry');
const { createShardRouter } = require('./shard-router');
const { createShardSupervisor } = require('./shard-supervisor');
const { createLocalShardProcessManager } = require('./local-shard-process-manager');
const {
  registerOrReplace,
  setupCoreInfrastructure,
  setupInferenceAndWorkflow,
  setupSessionRuntime,
  setupAgentAndPluginRuntime,
  setupBackgroundAndKnowledgeRuntime
} = require('./bootstrap-phases');

export interface BootstrapApplicationOptions {
  [key: string]: any;
  BrowserWindow?: any;
  agentinRoot?: string;
  app?: any;
  args?: string[];
  autoStartDaemons?: boolean;
  container?: any;
  createInitialWindow?: boolean;
  dbPath?: string;
  ipcMain?: any;
  isTestClientMode?: boolean;
  profileRegistry?: any;
  profileSwitcher?: any;
  profilesRoot?: string;
  runtimePolicy?: any;
  startupLogger?: any;
  startupProfiler?: any;
  startupTrace?: boolean;
  userDataPath?: string | null;
  userId?: string | null;
  windowManager?: any;
}

export interface BootstrapRuntime {
  container: any;
  handleActivate: () => any;
  profile: any;
  shutdown: () => Promise<void>;
  windowManager: any;
}

function resolveWindowManager(paths: any, options: BootstrapApplicationOptions = {}) {
  if (options.windowManager) {
    return options.windowManager;
  }

  return new WindowManager({
    BrowserWindow: options.BrowserWindow || null,
    rendererPath: options.rendererPath || paths.rendererPath,
    createWindow: options.createWindow || null
  });
}

async function getRemoteGatewaySecret(db: any, options: any = {}): Promise<string> {
  return await db.getCredential?.('remoteGateway.secret', options)
    || await db.getCredential?.('setting.remoteGateway.secret', options)
    || await db.getScopedSetting?.('remoteGateway.secret', options)
    || await db.getSetting('remoteGateway.secret')
    || '';
}

export async function bootstrapApplication(options: BootstrapApplicationOptions = {}): Promise<BootstrapRuntime> {
  const container = options.container || new ServiceContainer();
  const args = options.args || process.argv.slice(1);
  const startupProfiler = options.startupProfiler || createStartupProfiler({
    enabled: options.startupTrace === true || args.includes('--startup-trace'),
    logger: options.startupLogger || console
  });
  const isTestClientMode = options.isTestClientMode === true || args.includes('--testclient');
  const isExternalTestMode = args.includes('--external-test');
  const isSkinTestMode = args.includes('--skintest');
  const privateModeDefault = args.includes('--private');
  const isNoWindowMode = args.includes('--nowindow')
    || args.includes('--cli')
    || args.includes('--companion-qr')
    || args.includes('--noui')
    || args.includes('-noui')
    || args.includes('--windowless')
    || args.includes('-windowless');
  const ipcMain = options.ipcMain || null;
  const autoStartDaemons = options.autoStartDaemons !== false;
  const createInitialWindow = options.createInitialWindow !== false;
  const effectiveOptions = { ...options, args };
  startupProfiler.mark('bootstrap.begin', {
    test: isSkinTestMode || isTestClientMode || isExternalTestMode,
    windowless: isNoWindowMode,
    createInitialWindow,
    userId: null
  });
  let paths = startupProfiler.timeSync('runtime.paths', () => buildRuntimePaths(effectiveOptions));
  const windowManager = resolveWindowManager(paths, options);
  const runtimePolicy = options.runtimePolicy || container.optional?.('runtimePolicy') || new RuntimePolicy();
  const initialWindowOptions = options.initialWindowOptions && typeof options.initialWindowOptions === 'object'
    ? options.initialWindowOptions
    : {};
  const ctx: any = {
    activeProfile: null,
    container,
    options: effectiveOptions,
    profileRegistry: null,
    profileSwitcher: null,
    startupProfiler,
    paths,
    windowManager,
    initialWindowOptions,
    runtimePolicy,
    isTestClientMode,
    isExternalTestMode,
    isSkinTestMode,
    isNoWindowMode,
    privateModeDefault
  };

  await setupCoreInfrastructure(ctx);
  startupProfiler.timeSync('legacyAppDataMigration', () => runLegacyAppDataMigration({
    db: ctx.db,
    agentinRoot: paths.agentinRoot,
    userDataPath: paths.userDataPath
  }));
  const userRegistry = startupProfiler.timeSync('userRegistry.init', () => createUserRegistry({ db: ctx.db }));
  const defaultUser = startupProfiler.timeSync('userRegistry.seedDefault', () => userRegistry.getDefaultUser());
  const savedActiveUserId = String(
    options.userId || ctx.db.get("SELECT value FROM settings WHERE key = 'desktop.activeUserId'")?.value || ''
  ).trim();
  const resolvedActiveUser = userRegistry.getUser(savedActiveUserId) || defaultUser;
  paths = buildRuntimePaths({ ...effectiveOptions, userId: resolvedActiveUser.userId });
  ctx.paths = paths;
  registerOrReplace(container, 'runtimePaths', paths);
  const profileRegistry = startupProfiler.timeSync('profileRegistry.init', () => createProfileRegistry({
    agentinRoot: paths.agentinRoot,
    db: ctx.db,
    dbPath: ctx.db.dbPath,
    userDataPath: paths.userDataPath,
    userRegistry,
    activeUserId: resolvedActiveUser.userId
  }));
  const profileSwitcher = createProfileSwitcher({ profileRegistry });
  ctx.profileRegistry = profileRegistry;
  ctx.profileSwitcher = profileSwitcher;
  ctx.activeProfile = profileRegistry.getActiveProfile();
  registerOrReplace(container, 'profileRegistry', profileRegistry);
  registerOrReplace(container, 'profileSwitcher', profileSwitcher);
  registerOrReplace(container, 'activeProfile', ctx.activeProfile);
  registerOrReplace(container, 'userRegistry', userRegistry);
  registerOrReplace(container, 'activeUser', resolvedActiveUser);
  const userAuth = startupProfiler.timeSync('userAuth.init', () => createUserAuth({
    userRegistry,
    activeUser: resolvedActiveUser,
    onActiveUserChanged(nextUser) {
      profileRegistry.setActiveProfile(nextUser.userId);
      ctx.activeUser = nextUser;
      ctx.activeProfile = profileRegistry.getActiveProfile();
      registerOrReplace(container, 'activeUser', nextUser);
      registerOrReplace(container, 'activeProfile', ctx.activeProfile);
      ctx.eventBus?.publish?.('user:changed', { userId: nextUser.userId });
      windowManager.send?.('active-user-changed', { userId: nextUser.userId });
      ctx.pluginManager?.rebindUserScope?.(nextUser.userId).catch((error) => {
        console.error('[Bootstrap] Failed to rebind plugins after user switch:', error.message);
      });
    }
  }));
  registerOrReplace(container, 'userAuth', userAuth);
  ctx.userRegistry = userRegistry;
  ctx.userAuth = userAuth;
  ctx.activeUser = resolvedActiveUser;
  await setupInferenceAndWorkflow(ctx);
  await setupSessionRuntime(ctx);
  await setupAgentAndPluginRuntime(ctx);
  await setupBackgroundAndKnowledgeRuntime(ctx);

  const agentBundleLoader = startupProfiler.timeSync('agentBundleLoader.init', () => createAgentBundleLoader({
    db: ctx.db,
    agentManager: ctx.agentManager,
    pluginManager: ctx.pluginManager
  }));
  registerOrReplace(container, 'agentBundleLoader', agentBundleLoader);
  ctx.agentBundleLoader = agentBundleLoader;

  const shardRegistry = startupProfiler.timeSync('shardRegistry.init', () => createShardRegistry({
    db: ctx.db,
    logger: options.startupLogger || console
  }));
  registerOrReplace(container, 'shardRegistry', shardRegistry);
  ctx.shardRegistry = shardRegistry;

  const shardRouter = startupProfiler.timeSync('shardRouter.init', () => createShardRouter({
    shardRegistry,
    logger: options.startupLogger || console
  }));
  registerOrReplace(container, 'shardRouter', shardRouter);
  ctx.shardRouter = shardRouter;

  const coreApi = startupProfiler.timeSync('coreApi.init', () => createCoreApi({ container }));
  registerOrReplace(container, 'coreApi', coreApi);
  ctx.coreApi = coreApi;

  const shardSupervisor = startupProfiler.timeSync('shardSupervisor.init', () => createShardSupervisor({
    bundleLoader: agentBundleLoader,
    coreApi,
    logger: options.startupLogger || console,
    registry: shardRegistry,
    router: shardRouter
  }));
  registerOrReplace(container, 'shardSupervisor', shardSupervisor);
  ctx.shardSupervisor = shardSupervisor;

  const localShardProcessManager = startupProfiler.timeSync('localShardProcessManager.init', () => createLocalShardProcessManager({
    activeProfile: ctx.activeProfile || null,
    activeUser: ctx.activeUser || null,
    userAuth: ctx.userAuth || null,
    agentBundleLoader,
    agentManager: ctx.agentManager,
    db: ctx.db,
    logger: options.startupLogger || console,
    runtimePaths: paths,
    shardRegistry,
    shardSupervisor
  }));
  registerOrReplace(container, 'localShardProcessManager', localShardProcessManager);
  ctx.localShardProcessManager = localShardProcessManager;
  if (ctx.chainController && typeof ctx.chainController.setLocalShardProcessManager === 'function') {
    ctx.chainController.setLocalShardProcessManager(localShardProcessManager);
  }
  registerOrReplace(container, 'runtimeUiContext', options.runtimeUiContext || null);
  ctx.runtimeUiContext = options.runtimeUiContext || null;

  if (ipcMain) {
    startupProfiler.timeSync('ipc.register', () => setupIpcHandlers(ipcMain, container));
  }

  if (createInitialWindow) {
    startupProfiler.timeSync('window.createMain', () => windowManager.createMainWindow(initialWindowOptions));
  }

  ctx.eventBus.init({ windowManager, dispatcher: ctx.dispatcher, db: ctx.db });
  startupProfiler.mark('bootstrap.ready');

  scheduleNamedStartup('plugin.enablePersisted', startupProfiler, () => ctx.pluginManager.enablePersistedPlugins({ userId: ctx.activeUser?.userId || 'localuser' }));

  registerOrReplace(container, 'companionServer', null);
  const startCompanionServerFromSettings = async () => {
    let companionServer = null;
    const scopeOptions = { userId: ctx.activeUser?.userId || 'localuser' };
    try {
      await startupProfiler.time('companion.start', async () => {
        const host = resolveEasyConnectHost(await ctx.db.getScopedSetting('companion.host', scopeOptions) || '0.0.0.0');
        await ctx.db.saveScopedSetting('companion.host', host, scopeOptions);
        companionServer = new CompanionApiServer({
          host,
          port: Number(await ctx.db.getScopedSetting('companion.port', scopeOptions)) || 8790,
          tlsManager: container.get('companionTlsManager')
        });
        companionServer.setRemoteGatewayManager(ctx.remoteGatewayManager);
        configureCompanionServer({ companionServer, container, db: ctx.db });
        attachCompanionRelays({
          companionServer,
          eventBus: ctx.eventBus,
          windowManager,
          getCompanionServer: () => container.optional('companionServer') || companionServer
        });

        await companionServer.start();
        container.replace('companionServer', companionServer);
      });
      return companionServer;
    } catch (e) {
      console.error('[Bootstrap] Companion server start failed:', e);
      if (companionServer) {
        try { await companionServer.stop(); } catch (_error) {}
      }
      container.replace('companionServer', null);
      return null;
    }
  };
  const deferredStartup = createDeferredRuntimeStartup({
    db: ctx.db,
    startupProfiler,
    memoryDaemon: ctx.memoryDaemon,
    workflowScheduler: ctx.workflowScheduler,
    isTestClientMode,
    isExternalTestMode,
    isSkinTestMode,
    isNoWindowMode,
    startCompanionServerFromSettings,
    remoteGatewayManager: ctx.remoteGatewayManager,
    getRemoteGatewaySecret,
    scopeOptions: { userId: ctx.activeUser?.userId || 'localuser' }
  });
  await deferredStartup.schedule({ autoStartBackground: autoStartDaemons });

  return {
    container,
    profile: ctx.activeProfile || null,
    windowManager,
    handleActivate() {
      if (!windowManager.hasMainWindow()) {
        return windowManager.createMainWindow(initialWindowOptions);
      }
      return windowManager.getMainWindow();
    },
    async shutdown() {
      await deferredStartup.shutdown({ container });
    }
  };
}









