const { bootstrapApplication } = require('./bootstrap');
const { createExternalTestControl } = require('./external-test-control');
const { createStaticWindowManager } = require('./window-manager');

export interface StartServerOptions {
  [key: string]: any;
  BrowserWindow?: any;
  app?: any;
  args?: string[];
  autoStartDaemons?: boolean;
  createInitialWindow?: boolean;
  collectShardLogs?: ((payload: any, runtime: any) => Promise<any>) | null;
  controlHost?: string;
  controlPort?: number;
  deregisterShardHost?: ((payload: any, runtime: any) => Promise<any>) | null;
  deployShardBundle?: ((payload: any, runtime: any) => Promise<any>) | null;
  enableControlApi?: boolean;
  enableShardHost?: boolean;
  getDiagnostics?: (() => any) | null;
  getWindowCount?: (() => number) | null;
  ipcMain?: any;
  isTestClientMode?: boolean;
  registerShardHost?: ((record: any, runtime: any) => Promise<any>) | null;
  sendShardHeartbeat?: ((payload: any, runtime: any) => Promise<any>) | null;
  shardAuthToken?: string | null;
  shardBaseUrl?: string | null;
  shardCapabilities?: Record<string, any> | null;
  shardHeartbeatIntervalMs?: number;
  shardHost?: string | null;
  shardId?: string | null;
  shardLabel?: string | null;
  shardMetadata?: Record<string, any> | null;
  shardPort?: number;
  shutdownRuntime?: (() => Promise<void>) | null;
  windowManager?: any;
}

export interface StartServerResult {
  control: any;
  ipcBridge: any;
  runtime: any;
  shardHost: any;
  shutdown: () => Promise<void>;
}

export interface ServerRequestContextResolution {
  error?: string;
  ok: boolean;
  requestContext?: any;
  status?: number;
}

function normalizeOptionalString(value: any): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizePublishedHost(value: any): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  if (normalized === '0.0.0.0' || normalized === '::') {
    return '127.0.0.1';
  }
  return normalized;
}

function readHeader(headers: Record<string, any>, name: string): string | null {
  if (!headers || typeof headers !== 'object') {
    return null;
  }
  const direct = normalizeOptionalString(headers[name]);
  if (direct) {
    return direct;
  }
  const lowerName = String(name || '').trim().toLowerCase();
  if (!lowerName) {
    return null;
  }
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (String(headerName || '').trim().toLowerCase() === lowerName) {
      return normalizeOptionalString(headerValue);
    }
  }
  return null;
}

function extractAuthToken(headers: Record<string, any> = {}): string | null {
  const headerValue = readHeader(headers, 'authorization');
  if (!headerValue) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return normalizeOptionalString(match?.[1]);
}

function buildShardBaseUrl(options: StartServerOptions): string | null {
  const explicitBaseUrl = normalizeOptionalString(options.shardBaseUrl);
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }
  const host = normalizePublishedHost(options.shardHost) || normalizePublishedHost(options.controlHost) || '127.0.0.1';
  const port = Number.isFinite(options.shardPort)
    ? Number(options.shardPort)
    : (options.enableControlApi === true
      ? (Number.isFinite(options.controlPort) ? Number(options.controlPort) : 8788)
      : 0);
  if (port <= 0) {
    return null;
  }
  return `http://${host}:${port}`;
}

export async function resolveServerRequestContext(
  {
    headers = {}, payload = {}
  }: { headers?: Record<string, any>; payload?: any } = {},
  {
    activeProfile = null,
    companionAuth = null,
    userAuth = null
  }: { activeProfile?: any; companionAuth?: any; userAuth?: any } = {}
): Promise<ServerRequestContextResolution> {
  const payloadContext = payload?.requestContext && typeof payload.requestContext === 'object'
    ? payload.requestContext
    : {};
  const sessionId = normalizeOptionalString(
    payloadContext.sessionId
    || payloadContext.session_id
    || readHeader(headers, 'x-localagent-session-id')
  );
  const deviceId = normalizeOptionalString(
    payloadContext.deviceId
    || payloadContext.device_id
    || readHeader(headers, 'x-localagent-device-id')
  );
  const requestId = normalizeOptionalString(
    payloadContext.requestId
    || payloadContext.request_id
    || payload?.requestId
    || readHeader(headers, 'x-localagent-request-id')
  );

  const buildContext = (user = null) => {
    if (userAuth?.createHeadlessRequestContext) {
      return userAuth.createHeadlessRequestContext({
        deviceId,
        requestId,
        sessionId,
        user
      });
    }
    return {
      source: 'headless',
      userId: normalizeOptionalString(user?.userId || user) || undefined,
      sessionId: sessionId || undefined,
      deviceId: deviceId || undefined,
      requestId: requestId || undefined
    };
  };

  const authToken = extractAuthToken(headers);
  if (authToken && companionAuth?.validateAccessToken) {
    const authResult = await companionAuth.validateAccessToken(authToken);
    if (!authResult?.valid) {
      return { ok: false, status: 401, error: authResult?.error || 'Unauthorized' };
    }
    const device = authResult.payload || {};
    const tokenUserId = normalizeOptionalString(device.userId);
    if (!tokenUserId) {
      return { ok: false, status: 401, error: 'Authenticated headless requests must resolve to a concrete user' };
    }
    let resolvedUser = userAuth?.getUser ? userAuth.getUser(tokenUserId) : null;
    if (!resolvedUser && userAuth) {
      return { ok: false, status: 401, error: `Unknown headless user: ${tokenUserId}` };
    }
    return {
      ok: true,
      requestContext: buildContext(
        resolvedUser || {
          userId: tokenUserId
        }
      )
    };
  }

  const explicitUserId = normalizeOptionalString(
    payloadContext.userId
    || payloadContext.user_id
    || payload?.userId
    || readHeader(headers, 'x-localagent-user-id')
  );
  if (explicitUserId) {
    let resolvedUser = userAuth?.getUser ? userAuth.getUser(explicitUserId) : null;
    if (!resolvedUser && userAuth) {
      return { ok: false, status: 401, error: `Unknown headless user: ${explicitUserId}` };
    }
    return {
      ok: true,
      requestContext: buildContext(
        resolvedUser || {
          userId: explicitUserId
        }
      )
    };
  }

  const activeUser = userAuth?.getActiveUser ? userAuth.getActiveUser() : null;
  if (!activeUser?.userId) {
    return { ok: false, status: 401, error: 'Headless user identity required' };
  }
  return {
    ok: true,
    requestContext: buildContext(activeUser)
  };
}

export class HeadlessIpcBridge {
  handlers: Map<string, (...args: any[]) => any>;

  constructor() {
    this.handlers = new Map();
  }

  handle(channel: string, fn: (...args: any[]) => any) {
    this.handlers.set(channel, fn);
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

export async function startServer(options: StartServerOptions = {}): Promise<StartServerResult> {
  const ipcBridge = options.ipcMain || new HeadlessIpcBridge();
  const windowManager = options.windowManager || (!options.BrowserWindow ? createStaticWindowManager(null) : null);
  const runtime = await bootstrapApplication({
    ...options,
    app: options.app || null,
    BrowserWindow: options.BrowserWindow || null,
    ipcMain: ipcBridge,
    windowManager: windowManager || undefined,
    args: options.args || ['--external-test', '--windowless'],
    isTestClientMode: options.isTestClientMode === true,
    createInitialWindow: options.createInitialWindow === true,
    autoStartDaemons: options.autoStartDaemons !== false
  });

  let control = null;
  if (options.enableControlApi === true) {
    const container = runtime?.container || null;
    const userAuth = container?.optional?.('userAuth') || null;
    const companionAuth = container?.optional?.('companionAuth') || null;
    const activeProfile = container?.optional?.('activeProfile') || runtime?.profile || null;
    control = createExternalTestControl({
      invokeIpc: (channel: string, ...args: any[]) => ipcBridge.invoke(channel, ...args),
      invokeIpcWithEvent: (event: any, channel: string, ...args: any[]) => (
        typeof ipcBridge.invokeWithEvent === 'function'
          ? ipcBridge.invokeWithEvent(event, channel, ...args)
          : ipcBridge.invoke(channel, ...args)
      ),
      resolveRequestContext: (requestOptions: any) => resolveServerRequestContext(requestOptions, {
        activeProfile,
        companionAuth,
        userAuth
      }),
      shutdownRuntime: async () => {
        if (typeof options.shutdownRuntime === 'function') {
          await options.shutdownRuntime();
          return;
        }
        await runtime.shutdown();
      },
      getWindowCount: typeof options.getWindowCount === 'function'
        ? options.getWindowCount
        : () => 0,
      getDiagnostics: typeof options.getDiagnostics === 'function'
        ? options.getDiagnostics
        : () => {
          const startupProfiler = runtime?.container?.optional?.('startupProfiler');
          return {
            startupSummary: typeof startupProfiler?.summary === 'function'
              ? startupProfiler.summary()
              : []
          };
        },
      requiredAuthToken: options.shardAuthToken || null,
      port: Number.isFinite(options.controlPort) ? options.controlPort : 8788,
      host: options.controlHost || '127.0.0.1'
    });

    try {
      await control.start();
    } catch (error) {
      await runtime.shutdown();
      throw error;
    }
  }

  let shardHost = null;
  if (options.enableShardHost === true) {
    const container = runtime?.container || null;
    const shardSupervisor = container?.optional?.('shardSupervisor') || null;
    const userAuth = container?.optional?.('userAuth') || null;
    const activeProfile = container?.optional?.('activeProfile') || runtime?.profile || null;
    if (!shardSupervisor?.startLocalShardHost) {
      if (control) {
        await control.stop();
      }
      await runtime.shutdown();
      throw new Error('Shard host mode requires shardSupervisor');
    }

    const shardRequestContext = userAuth?.createHeadlessRequestContext
      ? userAuth.createHeadlessRequestContext({
          requestId: `shard-host-${Date.now()}`,
          userId: runtime.container?.optional?.('activeUser')?.userId || undefined
        })
      : {
          source: 'headless',
          requestId: `shard-host-${Date.now()}`,
          userId: runtime.container?.optional?.('activeUser')?.userId || undefined
        };

    try {
      shardHost = await shardSupervisor.startLocalShardHost({
        authToken: options.shardAuthToken || null,
        baseUrl: buildShardBaseUrl(options),
        capabilities: options.shardCapabilities || {},
        collectLogs: typeof options.collectShardLogs === 'function'
          ? (payload: any) => options.collectShardLogs!(payload, runtime)
          : null,
        deployBundle: typeof options.deployShardBundle === 'function'
          ? (payload: any) => options.deployShardBundle!(payload, runtime)
          : null,
        deregisterShard: typeof options.deregisterShardHost === 'function'
          ? (payload: any) => options.deregisterShardHost!(payload, runtime)
          : null,
        heartbeat: typeof options.sendShardHeartbeat === 'function'
          ? (payload: any) => options.sendShardHeartbeat!(payload, runtime)
          : null,
        heartbeatIntervalMs: Number.isFinite(options.shardHeartbeatIntervalMs)
          ? Number(options.shardHeartbeatIntervalMs)
          : undefined,
        host: options.shardHost || normalizePublishedHost(options.controlHost) || '127.0.0.1',
        label: options.shardLabel || 'Local Shard Host',
        metadata: options.shardMetadata || {},
        mode: options.createInitialWindow === true ? 'desktop' : 'headless',
        port: Number.isFinite(options.shardPort)
          ? Number(options.shardPort)
          : (options.enableControlApi === true && Number.isFinite(options.controlPort)
            ? Number(options.controlPort)
            : 0),
        registerShard: typeof options.registerShardHost === 'function'
          ? (record: any) => options.registerShardHost!(record, runtime)
          : null,
        requestContext: shardRequestContext,
        shardId: options.shardId || null,
        version: process.version
      });
    } catch (error) {
      if (control) {
        await control.stop();
      }
      await runtime.shutdown();
      throw error;
    }
  }

  return {
    control,
    ipcBridge,
    runtime,
    shardHost,
    async shutdown() {
      if (shardHost && typeof shardHost.stop === 'function') {
        await shardHost.stop();
      }
      if (control) {
        await control.stop();
      }
      await runtime.shutdown();
    }
  };
}


