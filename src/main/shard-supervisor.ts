import crypto = require('crypto');
import type {
  AgentBundleManifest,
  RequestContext,
  ShardCapabilities,
  ShardDeploymentRecord,
  ShardHealth,
  ShardRecord,
  ShardRoute
} from '../../shared/types';

export interface LocalShardHostOptions {
  authToken?: string | null;
  baseUrl?: string | null;
  capabilities?: ShardCapabilities | null;
  collectLogs?: ((payload: { limit?: number; requestContext?: RequestContext | null; shardId: string }) => Promise<any>) | null;
  deployBundle?: ((payload: { deployment: ShardDeploymentRecord; manifest: AgentBundleManifest; requestContext?: RequestContext | null; shard: ShardRecord }) => Promise<any>) | null;
  deregisterShard?: ((payload: { requestContext?: RequestContext | null; shardId: string }) => Promise<any>) | null;
  getHealth?: (() => Promise<Partial<ShardHealth> | null> | Partial<ShardHealth> | null) | null;
  heartbeat?: ((payload: { health: ShardHealth; record: ShardRecord; requestContext?: RequestContext | null; shardId: string }) => Promise<any>) | null;
  heartbeatIntervalMs?: number | null;
  host?: string | null;
  label?: string | null;
  metadata?: Record<string, any>;
  mode?: 'desktop' | 'headless' | 'shard-host';
  port?: number | null;
  userId?: string | null;
  registerShard?: ((record: ShardRecord) => Promise<any>) | null;
  requestContext?: RequestContext | null;
  shardId?: string | null;
  version?: string | null;
}

export interface LocalShardHostHandle {
  shardId: string;
  stop: () => Promise<void>;
}

export interface DeployBundleOptions {
  bundlePath?: string | null;
  manifest?: AgentBundleManifest | null;
  requestContext?: RequestContext | null;
  sendDeployment?: ((payload: { deployment: ShardDeploymentRecord; manifest: AgentBundleManifest; requestContext?: RequestContext | null; shard: ShardRecord }) => Promise<any>) | null;
  shardId?: string | null;
}

export interface ShardSupervisorOptions {
  bundleLoader: any;
  coreApi?: any;
  logger?: Pick<Console, 'error' | 'info' | 'warn'> | null;
  registry: any;
  router: any;
}

export interface ShardSupervisor {
  collectShardLogs(shardId: string, options?: { limit?: number; requestContext?: RequestContext | null }): Promise<any[]>;
  deployBundle(options: DeployBundleOptions): Promise<{ deployment: ShardDeploymentRecord; route: ShardRoute | null; shard: ShardRecord }>;
  deregisterShard(shardId: string): Promise<{ removed: boolean; shardId: string }>;
  heartbeatShard(shardId: string, healthPatch?: Partial<ShardHealth>): Promise<ShardRecord | null>;
  registerShard(input: Partial<ShardRecord> & { shardId: string }): Promise<ShardRecord>;
  routeBundle(options: { bundlePath?: string | null; manifest?: AgentBundleManifest | null; shardId?: string | null }): Promise<{ manifest: AgentBundleManifest; route: ShardRoute | null; shard: ShardRecord }>;
  startLocalShardHost(options?: LocalShardHostOptions): Promise<LocalShardHostHandle>;
  stopLocalShardHost(shardId: string): Promise<void>;
}

interface LocalShardState {
  callbacks: {
    collectLogs: LocalShardHostOptions['collectLogs'];
    deployBundle: LocalShardHostOptions['deployBundle'];
    deregisterShard: LocalShardHostOptions['deregisterShard'];
    heartbeat: LocalShardHostOptions['heartbeat'];
  };
  getHealth: LocalShardHostOptions['getHealth'];
  heartbeatIntervalMs: number;
  requestContext: RequestContext | Record<string, any> | null;
  timer: NodeJS.Timeout | null;
}

function normalizeString(value: any): string {
  return String(value || '').trim();
}

function normalizeOptionalString(value: any): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeNumber(value: any): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function createRandomId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(8).toString('hex');
}

function buildShardId(input: LocalShardHostOptions = {}): string {
  const explicit = normalizeOptionalString(input.shardId);
  if (explicit) {
    return explicit;
  }
  const seed = [
    normalizeOptionalString(input.label),
    normalizeOptionalString(input.host),
    normalizeOptionalString(input.port)
  ].filter(Boolean).join(':') || 'shard-host';
  return `${seed.replace(/[^a-z0-9._:-]+/gi, '-').toLowerCase()}-${createRandomId().slice(0, 8)}`;
}

export function createShardSupervisor(options: ShardSupervisorOptions): ShardSupervisor {
  const bundleLoader = options?.bundleLoader;
  const coreApi = options?.coreApi || null;
  const logger = options?.logger || console;
  const registry = options?.registry;
  const router = options?.router;
  const localHosts = new Map<string, LocalShardState>();

  if (!bundleLoader?.loadBundle) {
    throw new Error('ShardSupervisor requires bundleLoader');
  }
  if (!registry?.registerShard || !registry?.heartbeatShard || !registry?.recordDeployment || !registry?.getShard) {
    throw new Error('ShardSupervisor requires registry');
  }
  if (!router?.routeBundle) {
    throw new Error('ShardSupervisor requires router');
  }

  function resolveRequestContext(requestContext: RequestContext | null = null) {
    if (coreApi?.resolveRequestContext) {
      return coreApi.resolveRequestContext(requestContext || {});
    }
    return requestContext || null;
  }

  async function registerShard(input: Partial<ShardRecord> & { shardId: string }): Promise<ShardRecord> {
    return registry.registerShard(input);
  }

  async function heartbeatShard(shardId: string, healthPatch: Partial<ShardHealth> = {}): Promise<ShardRecord | null> {
    return registry.heartbeatShard(shardId, healthPatch);
  }

  async function deregisterShard(shardId: string): Promise<{ removed: boolean; shardId: string }> {
    return registry.deregisterShard(shardId);
  }

  async function routeBundle(routeOptions: { bundlePath?: string | null; manifest?: AgentBundleManifest | null; shardId?: string | null }): Promise<{ manifest: AgentBundleManifest; route: ShardRoute | null; shard: ShardRecord }> {
    const manifest = routeOptions.manifest || bundleLoader.loadBundle(String(routeOptions.bundlePath || ''));
    if (routeOptions.shardId) {
      const shard = await registry.getShard(routeOptions.shardId);
      if (!shard) {
        throw new Error(`Unknown shard: ${routeOptions.shardId}`);
      }
      return {
        manifest,
        route: {
          shardId: shard.shardId,
          score: 100,
          reasons: ['manual-target'],
          requiredCapabilities: [],
          missingCapabilities: [],
          bundleId: manifest.id
        },
        shard
      };
    }

    const route = await router.routeBundle(manifest);
    if (!route) {
      throw new Error(`No shard route available for bundle: ${manifest.id}`);
    }
    const shard = await registry.getShard(route.shardId);
    if (!shard) {
      throw new Error(`Routed shard missing from registry: ${route.shardId}`);
    }
    return { manifest, route, shard };
  }

  async function deployBundle(deployOptions: DeployBundleOptions): Promise<{ deployment: ShardDeploymentRecord; route: ShardRoute | null; shard: ShardRecord }> {
    const requestContext = resolveRequestContext(deployOptions.requestContext || null);
    const { manifest, route, shard } = await routeBundle({
      bundlePath: deployOptions.bundlePath || null,
      manifest: deployOptions.manifest || null,
      shardId: deployOptions.shardId || null
    });
    const deployment = await registry.recordDeployment({
      deploymentId: createRandomId(),
      shardId: shard.shardId,
      bundleId: manifest.id,
      bundleName: manifest.name,
      status: 'pending',
      metadata: {
        route,
        requestedAt: new Date().toISOString()
      }
    });

    const localState = localHosts.get(shard.shardId) || null;
    const deployFn = deployOptions.sendDeployment || localState?.callbacks.deployBundle || null;

    try {
      if (deployFn) {
        await deployFn({ deployment, manifest, shard, requestContext });
      }
      const updated = await registry.updateDeployment(deployment.deploymentId, {
        status: 'deployed',
        metadata: {
          ...(deployment.metadata || {}),
          deployedAt: new Date().toISOString()
        }
      });
      return { deployment: updated || deployment, route, shard };
    } catch (error: any) {
      await registry.updateDeployment(deployment.deploymentId, {
        status: 'failed',
        metadata: {
          ...(deployment.metadata || {}),
          failedAt: new Date().toISOString(),
          error: error?.message || String(error)
        }
      });
      throw error;
    }
  }

  async function collectShardLogs(shardId: string, collectOptions: { limit?: number; requestContext?: RequestContext | null } = {}): Promise<any[]> {
    const localState = localHosts.get(normalizeString(shardId)) || null;
    if (!localState?.callbacks.collectLogs) {
      return [];
    }
    const result = await localState.callbacks.collectLogs({
      shardId: normalizeString(shardId),
      limit: normalizeNumber(collectOptions.limit),
      requestContext: resolveRequestContext(collectOptions.requestContext || null)
    });
    return Array.isArray(result) ? result : [];
  }

  async function runHeartbeat(shardId: string): Promise<void> {
    const localState = localHosts.get(shardId);
    if (!localState) {
      return;
    }
    const shard = await registry.getShard(shardId);
    if (!shard) {
      return;
    }
    const sampledHealth = typeof localState.getHealth === 'function'
      ? await localState.getHealth()
      : null;
    const health: ShardHealth = {
      ...shard.health,
      ...(sampledHealth || {}),
      status: (sampledHealth?.status || shard.health.status || 'online') as ShardHealth['status'],
      heartbeatIntervalMs: localState.heartbeatIntervalMs,
      lastHeartbeatAt: new Date().toISOString()
    };

    if (localState.callbacks.heartbeat) {
      await localState.callbacks.heartbeat({
        shardId,
        health,
        record: shard,
        requestContext: localState.requestContext as RequestContext | null
      });
      return;
    }

    await registry.heartbeatShard(shardId, health);
  }

  async function startLocalShardHost(hostOptions: LocalShardHostOptions = {}): Promise<LocalShardHostHandle> {
    const shardId = buildShardId(hostOptions);
    if (localHosts.has(shardId)) {
      return {
        shardId,
        stop: async () => stopLocalShardHost(shardId)
      };
    }

    const requestContext = resolveRequestContext(hostOptions.requestContext || null);
    const heartbeatIntervalMs = Math.max(5000, Number(hostOptions.heartbeatIntervalMs) || 30000);
    const now = new Date().toISOString();
    const record: ShardRecord = {
      shardId,
      label: normalizeOptionalString(hostOptions.label) || shardId,
      host: normalizeOptionalString(hostOptions.host) || '127.0.0.1',
      port: normalizeNumber(hostOptions.port) ?? 0,
      baseUrl: normalizeOptionalString(hostOptions.baseUrl) || null,
      authToken: normalizeOptionalString(hostOptions.authToken) || null,
      capabilities: hostOptions.capabilities || {},
      health: {
        status: 'online',
        lastHeartbeatAt: now,
        heartbeatIntervalMs,
        activeRuns: 0,
        deployedBundles: 0,
        load: null,
        observedLatencyMs: null,
        error: null
      },
      runtime: {
        version: normalizeOptionalString(hostOptions.version) || process.version,
        mode: hostOptions.mode || 'shard-host',
        userId: normalizeOptionalString(hostOptions.userId || hostOptions.requestContext?.userId) || null
      },
      metadata: hostOptions.metadata || {},
      registeredAt: now,
      createdAt: now,
      updatedAt: now
    };

    if (hostOptions.registerShard) {
      await hostOptions.registerShard(record);
    } else {
      await registry.registerShard(record);
    }

    const state: LocalShardState = {
      callbacks: {
        collectLogs: hostOptions.collectLogs || null,
        deployBundle: hostOptions.deployBundle || null,
        deregisterShard: hostOptions.deregisterShard || null,
        heartbeat: hostOptions.heartbeat || null
      },
      getHealth: hostOptions.getHealth || null,
      heartbeatIntervalMs,
      requestContext,
      timer: null
    };
    localHosts.set(shardId, state);

    state.timer = setInterval(() => {
      runHeartbeat(shardId).catch((error: any) => {
        logger.warn?.(`[ShardSupervisor] Heartbeat failed for ${shardId}: ${error?.message || error}`);
      });
    }, heartbeatIntervalMs);

    return {
      shardId,
      stop: async () => stopLocalShardHost(shardId)
    };
  }

  async function stopLocalShardHost(shardId: string): Promise<void> {
    const normalizedShardId = normalizeString(shardId);
    const state = localHosts.get(normalizedShardId);
    if (!state) {
      return;
    }
    if (state.timer) {
      clearInterval(state.timer);
    }
    if (state.callbacks.deregisterShard) {
      await state.callbacks.deregisterShard({
        shardId: normalizedShardId,
        requestContext: state.requestContext as RequestContext | null
      });
    } else {
      await registry.deregisterShard(normalizedShardId);
    }
    localHosts.delete(normalizedShardId);
  }

  return {
    collectShardLogs,
    deployBundle,
    deregisterShard,
    heartbeatShard,
    registerShard,
    routeBundle,
    startLocalShardHost,
    stopLocalShardHost
  };
}
