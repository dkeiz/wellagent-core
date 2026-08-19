const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { resolveProjectPath } = require('./runtime-root');
const { buildRuntimePaths } = require('./runtime-paths');
const { bootstrapApplication } = require('./bootstrap');
const { startServer } = require('./server-entry');
function runCheckSkins() { return require(resolveProjectPath(__dirname, 'tools', 'check-skins.js')).runCheckSkins(); }
function runApplySimulation() { return require(resolveProjectPath(__dirname, 'tools', 'test-skin-apply.js')).runApplySimulation(); }

function wrapConsoleMethod(name: string) {
  const original = console[name as keyof Console];
  if (typeof original !== 'function') return;
  console[name as keyof Console] = ((...args: any[]) => {
    try {
      return original.apply(console, args as []);
    } catch (error) {
      if (error?.code === 'EPIPE') return;
      throw error;
    }
  }) as any;
}

function ignoreBrokenPipeErrors(stream: any) {
  if (!stream?.on) return;
  stream.on('error', (error: any) => {
    if (error?.code === 'EPIPE') return;
    throw error;
  });
}

wrapConsoleMethod('log');
wrapConsoleMethod('info');
wrapConsoleMethod('warn');
wrapConsoleMethod('error');
ignoreBrokenPipeErrors(process.stdout);
ignoreBrokenPipeErrors(process.stderr);
process.on('uncaughtException', (error: any) => {
  if (error?.code === 'EPIPE') return;
  throw error;
});

let runtime = null;
let externalTestControl = null;
let shutdownPromise: Promise<void> | null = null;
let allowImmediateQuit = false;

const args = process.argv.slice(1);
const isSkinTestMode = args.includes('--skintest');
const isDevMode = args.includes('--dev');
const isCliMode = args.includes('--cli');
const isCompanionQrMode = args.includes('--companion-qr');
const isNoWindowMode = args.includes('--nowindow')
  || isCliMode
  || isCompanionQrMode
  || args.includes('--noui')
  || args.includes('-noui');
const isTestClientMode = args.includes('--testclient');
const isExternalTestMode = args.includes('--external-test');
const isWindowlessMode = args.includes('--windowless')
  || args.includes('-windowless')
  || isNoWindowMode;
const controlPortArg = args.find((value) => value.startsWith('--external-port=')) || args.find((value) => value.startsWith('--control-port=')) || null;
const externalPortArgIdx = args.indexOf('--external-port');
const controlPortArgIdx = args.indexOf('--control-port');
const externalPort = controlPortArg
  ? Number(controlPortArg.split('=')[1])
  : (externalPortArgIdx !== -1 && args[externalPortArgIdx + 1]
    ? Number(args[externalPortArgIdx + 1])
    : (controlPortArgIdx !== -1 && args[controlPortArgIdx + 1]
      ? Number(args[controlPortArgIdx + 1])
      : 8788));
const enableControlApi = args.includes('--control-api') || isExternalTestMode;
const enableShardHost = args.includes('--enable-shard-host');
const controlAuthTokenArg = args.find((value) => value.startsWith('--control-auth-token=')) || null;
const controlAuthTokenIdx = args.indexOf('--control-auth-token');
const controlAuthToken = controlAuthTokenArg
  ? controlAuthTokenArg.slice('--control-auth-token='.length)
  : (controlAuthTokenIdx !== -1 && args[controlAuthTokenIdx + 1] ? args[controlAuthTokenIdx + 1] : null);
const shardUiArg = args.find((value) => value.startsWith('--shard-ui=')) || null;
const shardUiMode = shardUiArg ? shardUiArg.slice('--shard-ui='.length).trim().toLowerCase() : '';
const shardIdArg = args.find((value) => value.startsWith('--shard-id=')) || null;
const shardIdIdx = args.indexOf('--shard-id');
const shardId = shardIdArg ? shardIdArg.slice('--shard-id='.length) : (shardIdIdx !== -1 && args[shardIdIdx + 1] ? args[shardIdIdx + 1] : null);
const shardLabelArg = args.find((value) => value.startsWith('--shard-label=')) || null;
const shardLabelIdx = args.indexOf('--shard-label');
const shardLabel = shardLabelArg ? shardLabelArg.slice('--shard-label='.length) : (shardLabelIdx !== -1 && args[shardLabelIdx + 1] ? args[shardLabelIdx + 1] : null);
const shardAgentIdArg = args.find((value) => value.startsWith('--shard-agent-id=')) || null;
const shardAgentIdIdx = args.indexOf('--shard-agent-id');
const shardAgentId = shardAgentIdArg
  ? Number(shardAgentIdArg.slice('--shard-agent-id='.length))
  : (shardAgentIdIdx !== -1 && args[shardAgentIdIdx + 1] ? Number(args[shardAgentIdIdx + 1]) : null);
const shardSessionIdArg = args.find((value) => value.startsWith('--shard-session-id=')) || null;
const shardSessionIdIdx = args.indexOf('--shard-session-id');
const shardSessionId = shardSessionIdArg
  ? shardSessionIdArg.slice('--shard-session-id='.length)
  : (shardSessionIdIdx !== -1 && args[shardSessionIdIdx + 1] ? args[shardSessionIdIdx + 1] : null);
const useServerBootstrap = isWindowlessMode || enableControlApi || enableShardHost;
const isCompactShardUiMode = shardUiMode === 'compact';
const rendererPath = isCompactShardUiMode
  ? resolveProjectPath(__dirname, 'src', 'renderer', 'shard-runtime.html')
  : undefined;
const initialWindowOptions = isCompactShardUiMode
  ? {
      width: 560,
      height: 820,
      minWidth: 420,
      minHeight: 540,
      resizable: true,
      title: String(shardLabel || 'LocalAgent Shard Runtime').trim() || 'LocalAgent Shard Runtime'
    }
  : undefined;
const runtimeUiContext = isCompactShardUiMode
  ? {
      mode: 'shard-compact',
      agentId: Number.isFinite(shardAgentId) ? Number(shardAgentId) : null,
      sessionId: String(shardSessionId || '').trim() || null,
      shardId: String(shardId || '').trim() || null,
      shardLabel: String(shardLabel || '').trim() || null
    }
  : null;

function readValueArg(name) {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim() || null;
  const index = args.indexOf(name);
  return index !== -1 ? String(args[index + 1] || '').trim() || null : null;
}
const explicitAgentinRoot = readValueArg('--agentin-root');
const explicitDbPath = readValueArg('--db-path');
const explicitUserId = readValueArg('--user');

const explicitDataRoot = process.env.LOCALAGENT_DATA_ROOT
  || process.env.LOCALAGENT_USER_DATA_PATH
  || readValueArg('--data-root');
const isolatedTestDataRoot = isExternalTestMode && !explicitDataRoot && !explicitDbPath
  ? path.join(require('os').tmpdir(), `localagent-external-test-${process.pid}`)
  : undefined;
const startupPaths = buildRuntimePaths({
  agentinRoot: explicitAgentinRoot || undefined,
  dbPath: explicitDbPath || undefined,
  dataRoot: explicitDataRoot || isolatedTestDataRoot
});

process.env.LOCALAGENT_ELECTRON_APP_RUNTIME = '1';

class IpcBridge {
  realIpcMain: any;
  handlers: Map<string, (...args: any[]) => any>;

  constructor(realIpcMain: any) {
    this.realIpcMain = realIpcMain;
    this.handlers = new Map();
  }

  handle(channel: string, fn: (...args: any[]) => any) {
    this.handlers.set(channel, fn);
    this.realIpcMain.handle(channel, fn);
  }

  async invoke(channel: string, ...invokeArgs: any[]) {
    return this.invokeWithEvent({}, channel, ...invokeArgs);
  }

  async invokeWithEvent(event: any, channel: string, ...invokeArgs: any[]) {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`Unknown IPC channel: ${channel}`);
    }
    return handler(event || {}, ...invokeArgs);
  }
}

const ipcBridge = new IpcBridge(ipcMain);

if (!app || typeof app.whenReady !== 'function') {
  if (isSkinTestMode && isNoWindowMode) {
    console.log('[SkinTest] Running in Node fallback mode...');
    const started = Date.now();
    const skinCheck = runCheckSkins();
    const skinApplySimulation = runApplySimulation();
    const durationMs = Date.now() - started;
    const report = {
      mode: 'skintest-nowindow-node-fallback',
      durationMs,
      checks: {
        skins: skinCheck,
        skinApplySimulation
      }
    };
    console.log('[SkinTest] Report:');
    console.log(JSON.stringify(report, null, 2));
    process.exit(skinCheck.ok && skinApplySimulation.ok ? 0 : 1);
  } else {
    throw new Error('Electron app context is unavailable. Run this entrypoint with Electron for normal app mode.');
  }
}

async function runHeadlessSkinChecks() {
  console.log('[SkinTest] Starting --skintest --nowindow checks...');
  const started = Date.now();
  const skinCheck = runCheckSkins();
  const skinApplySimulation = runApplySimulation();
  const durationMs = Date.now() - started;
  const report = {
    mode: 'skintest-nowindow',
    durationMs,
    checks: {
      skins: skinCheck,
      skinApplySimulation
    }
  };
  console.log('[SkinTest] Report:');
  console.log(JSON.stringify(report, null, 2));
  app.exit(skinCheck.ok && skinApplySimulation.ok ? 0 : 1);
}

async function runSeedScript(container: any) {
  const seedIdx = process.argv.indexOf('--seed');
  if (seedIdx === -1 || !process.argv[seedIdx + 1]) {
    return;
  }

  const seedPath = path.resolve(process.argv[seedIdx + 1]);
  console.log(`[Seed] Running seed script: ${seedPath}`);
  try {
    const seedFn = require(seedPath);
    if (typeof seedFn === 'function') {
      await seedFn({
        container,
        db: container.get('db'),
        workflowManager: container.get('workflowManager'),
        mcpServer: container.get('mcpServer')
      });
      console.log('[Seed] Seed script completed successfully');
    } else {
      console.error('[Seed] Seed script must export a function: module.exports = async ({ db, workflowManager }) => { ... }');
    }
  } catch (error) {
    console.error('[Seed] Seed script failed:', error);
  }
}

async function runCompanionQrOutput() {
  const status = await ipcBridge.invoke('companion:status');
  const host = String(status?.host || '0.0.0.0').trim() || '0.0.0.0';
  const port = Number(status?.port) || 8790;

  let ensuredStatus = status;
  if (!status?.running) {
    ensuredStatus = await ipcBridge.invoke('companion:enable', { host, port });
    if (ensuredStatus?.success === false) {
      throw new Error(ensuredStatus.error || 'Failed to start companion server');
    }
  }

  const pairing = await ipcBridge.invoke('companion:generate-pairing');
  if (!pairing?.success) {
    throw new Error(pairing?.error || 'Failed to generate companion pairing code');
  }
  if (!pairing.nativeAppUrl || !pairing.preferredBrowserUrl) {
    throw new Error('Companion pairing payload is missing QR targets');
  }

  const appQr = await ipcBridge.invoke('companion:render-qr', pairing.nativeAppUrl);
  const webQr = await ipcBridge.invoke('companion:render-qr', pairing.preferredBrowserUrl);
  if (!appQr?.success || !webQr?.success) {
    throw new Error(appQr?.error || webQr?.error || 'Failed to render companion QR codes');
  }

  console.log('[CompanionQR] Pairing code:', pairing.code);
  console.log('[CompanionQR] Expires:', pairing.expiresAt);
  console.log('[CompanionQR] App URL:', pairing.nativeAppUrl);
  console.log('[CompanionQR] Web URL:', pairing.preferredBrowserUrl);
  console.log('[CompanionQR] Access mode:', ensuredStatus?.accessMode || 'unknown');
  console.log('');
  console.log('[CompanionQR] Android App QR');
  console.log(appQr.terminal);
  console.log('');
  console.log('[CompanionQR] Web Companion QR');
  console.log(webQr.terminal);
}

app.whenReady().then(async () => {
  try {
    if (!isDevMode && Menu && typeof Menu.setApplicationMenu === 'function') {
      Menu.setApplicationMenu(null);
    }

    if (isSkinTestMode && isNoWindowMode) {
      await runHeadlessSkinChecks();
      return;
    }

    if (useServerBootstrap) {
      const serverRuntime = await startServer({
        createInitialWindow: !isWindowlessMode,
        app,
        BrowserWindow,
        ipcMain: ipcBridge,
        args,
        agentinRoot: explicitAgentinRoot || undefined,
        dbPath: startupPaths.databasePath,
        userDataPath: startupPaths.userDataPath,
        userId: explicitUserId || undefined,
        rendererPath,
        initialWindowOptions,
        runtimeUiContext,
        isTestClientMode,
        autoStartDaemons: !isExternalTestMode,
        enableControlApi,
        enableShardHost,
        controlPort: Number.isFinite(externalPort) ? externalPort : 8788,
        controlHost: '127.0.0.1',
        shardAuthToken: controlAuthToken || null,
        shardId: shardId || null,
        shardLabel: shardLabel || 'Local Shard Host',
        shutdownRuntime: async () => {
          if (runtime) {
            await runtime.shutdown();
          }
          app.exit(0);
        },
        getWindowCount: () => {
          try {
            return BrowserWindow.getAllWindows().length;
          } catch (_error) {
            return -1;
          }
        },
        getDiagnostics: () => {
          const startupProfiler = runtime?.container?.optional?.('startupProfiler');
          return {
            startupSummary: typeof startupProfiler?.summary === 'function'
              ? startupProfiler.summary()
              : []
          };
        }
      });
      runtime = serverRuntime.runtime;
      externalTestControl = serverRuntime.control;
    } else {
      runtime = await bootstrapApplication({
        app,
        BrowserWindow,
        ipcMain: ipcBridge,
        args,
        agentinRoot: explicitAgentinRoot || undefined,
        dbPath: startupPaths.databasePath,
        userDataPath: startupPaths.userDataPath,
        userId: explicitUserId || undefined,
        rendererPath,
        initialWindowOptions,
        runtimeUiContext,
        isTestClientMode,
        createInitialWindow: true,
        autoStartDaemons: !isExternalTestMode
      });
    }

    if (isTestClientMode) {
      console.log('[TestClient] Enabled transient chat mode (--testclient)');
    }

    await runSeedScript(runtime.container);

    if (isCompanionQrMode) {
      await runCompanionQrOutput();
      await runShutdownSequence();
      allowImmediateQuit = true;
      app.exit(0);
      return;
    }

    app.on('activate', () => {
      runtime?.handleActivate();
    });
  } catch (error) {
    console.error('Error during app initialization:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (isWindowlessMode) return;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

async function runShutdownSequence() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    if (externalTestControl) {
      try {
        await externalTestControl.stop();
      } finally {
        externalTestControl = null;
      }
    }

    if (runtime) {
      await runtime.shutdown();
      runtime = null;
    }
  })();

  await shutdownPromise;
}

app.on('before-quit', (event: any) => {
  if (allowImmediateQuit) {
    return;
  }

  event.preventDefault();
  runShutdownSequence()
    .catch((error) => {
      console.error('[Main] Shutdown sequence failed:', error);
    })
    .finally(() => {
      allowImmediateQuit = true;
      app.quit();
    });
});

export {};

