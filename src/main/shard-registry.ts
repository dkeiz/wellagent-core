import type {
  ShardCapabilities,
  ShardDeploymentRecord,
  ShardHealth,
  ShardRecord,
  ShardStatus
} from '../../shared/types';

const SHARDS_SETTING_KEY = 'shards.registry.v1';
const DEPLOYMENTS_SETTING_KEY = 'shards.deployments.v1';
const DEFAULT_STALE_AFTER_MS = 120000;

export interface ShardRegistryOptions {
  db: any;
  logger?: Pick<Console, 'warn'> | null;
  staleAfterMs?: number;
}

export interface ShardRegistry {
  deregisterShard(shardId: string): Promise<{ removed: boolean; shardId: string }>;
  getShard(shardId: string): Promise<ShardRecord | null>;
  heartbeatShard(shardId: string, healthPatch?: Partial<ShardHealth>): Promise<ShardRecord | null>;
  listDeployments(filters?: { bundleId?: string | null; shardId?: string | null; status?: string | null }): Promise<ShardDeploymentRecord[]>;
  listShards(options?: { includeOffline?: boolean }): Promise<ShardRecord[]>;
  pruneStaleShards(now?: number | Date): Promise<ShardRecord[]>;
  recordDeployment(input: Partial<ShardDeploymentRecord> & { bundleId: string; shardId: string }): Promise<ShardDeploymentRecord>;
  registerShard(input: Partial<ShardRecord> & { shardId: string }): Promise<ShardRecord>;
  updateDeployment(deploymentId: string, patch: Partial<ShardDeploymentRecord>): Promise<ShardDeploymentRecord | null>;
  updateShard(shardId: string, patch: Partial<ShardRecord>): Promise<ShardRecord | null>;
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

function uniqueStrings(values: any[] = []): string[] {
  return Array.from(new Set(values.map(value => normalizeString(value)).filter(Boolean)));
}

function parseJsonArray(rawValue: any): any[] {
  if (Array.isArray(rawValue)) {
    return rawValue;
  }
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(String(rawValue));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function normalizeStatus(value: any): ShardStatus {
  switch (normalizeString(value).toLowerCase()) {
    case 'online':
    case 'degraded':
    case 'offline':
    case 'draining':
      return normalizeString(value).toLowerCase() as ShardStatus;
    default:
      return 'unknown';
  }
}

function normalizeCapabilities(input: any = {}, existing: ShardCapabilities = {}): ShardCapabilities {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    filesystem: typeof source.filesystem === 'boolean' ? source.filesystem : existing.filesystem,
    terminal: typeof source.terminal === 'boolean' ? source.terminal : existing.terminal,
    knowledge: typeof source.knowledge === 'boolean' ? source.knowledge : existing.knowledge,
    audio: typeof source.audio === 'boolean' ? source.audio : existing.audio,
    network: typeof source.network === 'boolean' ? source.network : existing.network,
    maxConcurrentAgents: normalizeNumber(source.maxConcurrentAgents) ?? existing.maxConcurrentAgents,
    maxConcurrentTools: normalizeNumber(source.maxConcurrentTools) ?? existing.maxConcurrentTools,
    supportedProviders: source.supportedProviders ? uniqueStrings(source.supportedProviders) : (existing.supportedProviders || []),
    supportedModels: source.supportedModels ? uniqueStrings(source.supportedModels) : (existing.supportedModels || []),
    tags: source.tags ? uniqueStrings(source.tags) : (existing.tags || [])
  };
}

function normalizeHealth(input: any = {}, existing: ShardHealth | null = null): ShardHealth {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    status: normalizeStatus(source.status || existing?.status || 'unknown'),
    lastHeartbeatAt: normalizeOptionalString(source.lastHeartbeatAt) || existing?.lastHeartbeatAt || null,
    heartbeatIntervalMs: normalizeNumber(source.heartbeatIntervalMs) ?? existing?.heartbeatIntervalMs ?? null,
    observedLatencyMs: normalizeNumber(source.observedLatencyMs) ?? existing?.observedLatencyMs ?? null,
    activeRuns: normalizeNumber(source.activeRuns) ?? existing?.activeRuns ?? 0,
    deployedBundles: normalizeNumber(source.deployedBundles) ?? existing?.deployedBundles ?? 0,
    load: normalizeNumber(source.load) ?? existing?.load ?? null,
    error: normalizeOptionalString(source.error) || existing?.error || null
  };
}

function buildBaseUrl(host: string, port: number, currentValue: string | null = null): string | null {
  if (currentValue) {
    return currentValue;
  }
  if (!host || !Number.isFinite(port) || port <= 0) {
    return null;
  }
  return `http://${host}:${port}`;
}

function normalizeMetadata(input: any, existing: Record<string, any> | undefined): Record<string, any> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...(existing || {}), ...input };
  }
  return existing;
}

function normalizeRecord(input: any, existing: ShardRecord | null = null): ShardRecord {
  const now = new Date().toISOString();
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const host = normalizeString(source.host || existing?.host || '127.0.0.1');
  const port = normalizeNumber(source.port) ?? existing?.port ?? 0;
  const runtimeSource = source.runtime && typeof source.runtime === 'object' && !Array.isArray(source.runtime)
    ? source.runtime
    : {};

  return {
    shardId: normalizeString(source.shardId || existing?.shardId),
    label: normalizeString(source.label || existing?.label || source.shardId || 'Shard Host'),
    host,
    port,
    baseUrl: buildBaseUrl(host, port, normalizeOptionalString(source.baseUrl) || existing?.baseUrl || null),
    authToken: normalizeOptionalString(source.authToken) || existing?.authToken || null,
    capabilities: normalizeCapabilities(source.capabilities, existing?.capabilities),
    health: normalizeHealth(source.health, existing?.health || null),
    runtime: {
      version: normalizeOptionalString(runtimeSource.version) || existing?.runtime?.version || undefined,
      mode: runtimeSource.mode || existing?.runtime?.mode || 'headless',
      userId: normalizeOptionalString(runtimeSource.userId) || existing?.runtime?.userId || null
    },
    metadata: normalizeMetadata(source.metadata, existing?.metadata),
    registeredAt: normalizeOptionalString(source.registeredAt) || existing?.registeredAt || now,
    createdAt: existing?.createdAt || normalizeOptionalString(source.createdAt) || now,
    updatedAt: now
  };
}

function normalizeDeploymentStatus(value: any): ShardDeploymentRecord['status'] {
  switch (normalizeString(value).toLowerCase()) {
    case 'pending':
    case 'deployed':
    case 'failed':
    case 'removed':
      return normalizeString(value).toLowerCase() as ShardDeploymentRecord['status'];
    default:
      return 'pending';
  }
}

function normalizeDeployment(input: any, existing: ShardDeploymentRecord | null = null): ShardDeploymentRecord {
  const now = new Date().toISOString();
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    deploymentId: normalizeString(source.deploymentId || existing?.deploymentId),
    shardId: normalizeString(source.shardId || existing?.shardId),
    bundleId: normalizeString(source.bundleId || existing?.bundleId),
    bundleName: normalizeString(source.bundleName || existing?.bundleName || source.bundleId || 'bundle'),
    status: normalizeDeploymentStatus(source.status || existing?.status || 'pending'),
    createdAt: existing?.createdAt || normalizeOptionalString(source.createdAt) || now,
    updatedAt: now,
    metadata: normalizeMetadata(source.metadata, existing?.metadata)
  };
}

function applyFreshness(record: ShardRecord, staleAfterMs: number): ShardRecord {
  const heartbeatTime = record.health.lastHeartbeatAt ? Date.parse(record.health.lastHeartbeatAt) : NaN;
  if (!Number.isFinite(heartbeatTime)) {
    return record;
  }
  const ageMs = Date.now() - heartbeatTime;
  if (ageMs <= staleAfterMs || record.health.status === 'offline' || record.health.status === 'draining') {
    return record;
  }
  return {
    ...record,
    health: {
      ...record.health,
      status: 'offline',
      error: record.health.error || `Heartbeat stale for ${ageMs}ms`
    }
  };
}

export function createShardRegistry(options: ShardRegistryOptions): ShardRegistry {
  const db = options?.db;
  const logger = options?.logger || console;
  const staleAfterMs = Math.max(30000, Number(options?.staleAfterMs) || DEFAULT_STALE_AFTER_MS);

  if (!db?.getSetting || !db?.saveSetting) {
    throw new Error('ShardRegistry requires db with getSetting/saveSetting');
  }

  async function readShardRecords(): Promise<ShardRecord[]> {
    const items = parseJsonArray(await db.getSetting(SHARDS_SETTING_KEY));
    return items
      .map(item => normalizeRecord(item))
      .filter(record => Boolean(record.shardId));
  }

  async function writeShardRecords(records: ShardRecord[]): Promise<ShardRecord[]> {
    await db.saveSetting(SHARDS_SETTING_KEY, JSON.stringify(records, null, 2));
    return records;
  }

  async function readDeployments(): Promise<ShardDeploymentRecord[]> {
    const items = parseJsonArray(await db.getSetting(DEPLOYMENTS_SETTING_KEY));
    return items
      .map(item => normalizeDeployment(item))
      .filter(record => Boolean(record.deploymentId) && Boolean(record.shardId) && Boolean(record.bundleId));
  }

  async function writeDeployments(records: ShardDeploymentRecord[]): Promise<ShardDeploymentRecord[]> {
    await db.saveSetting(DEPLOYMENTS_SETTING_KEY, JSON.stringify(records, null, 2));
    return records;
  }

  async function getShard(shardId: string): Promise<ShardRecord | null> {
    const normalizedShardId = normalizeString(shardId);
    if (!normalizedShardId) {
      return null;
    }
    const match = (await readShardRecords()).find(record => record.shardId === normalizedShardId) || null;
    return match ? applyFreshness(match, staleAfterMs) : null;
  }

  async function listShards(options: { includeOffline?: boolean } = {}): Promise<ShardRecord[]> {
    const includeOffline = options.includeOffline !== false;
    const records = (await readShardRecords())
      .map(record => applyFreshness(record, staleAfterMs))
      .sort((left, right) => left.label.localeCompare(right.label));
    return includeOffline ? records : records.filter(record => record.health.status !== 'offline');
  }

  async function registerShard(input: Partial<ShardRecord> & { shardId: string }): Promise<ShardRecord> {
    const records = await readShardRecords();
    const normalizedShardId = normalizeString(input.shardId);
    if (!normalizedShardId) {
      throw new Error('registerShard requires shardId');
    }
    const index = records.findIndex(record => record.shardId === normalizedShardId);
    const existing = index >= 0 ? records[index] : null;
    const next = normalizeRecord({
      ...existing,
      ...input,
      shardId: normalizedShardId,
      health: {
        ...(existing?.health || {}),
        ...(input.health || {}),
        lastHeartbeatAt: normalizeOptionalString(input.health?.lastHeartbeatAt) || existing?.health?.lastHeartbeatAt || new Date().toISOString()
      }
    }, existing);
    if (index >= 0) {
      records[index] = next;
    } else {
      records.push(next);
    }
    await writeShardRecords(records);
    return applyFreshness(next, staleAfterMs);
  }

  async function updateShard(shardId: string, patch: Partial<ShardRecord>): Promise<ShardRecord | null> {
    const records = await readShardRecords();
    const normalizedShardId = normalizeString(shardId);
    const index = records.findIndex(record => record.shardId === normalizedShardId);
    if (index < 0) {
      return null;
    }
    const existing = records[index];
    const next = normalizeRecord({
      ...existing,
      ...patch,
      shardId: normalizedShardId,
      capabilities: {
        ...(existing.capabilities || {}),
        ...(patch.capabilities || {})
      },
      health: {
        ...(existing.health || {}),
        ...(patch.health || {})
      },
      runtime: {
        ...(existing.runtime || {}),
        ...(patch.runtime || {})
      },
      metadata: {
        ...(existing.metadata || {}),
        ...(patch.metadata || {})
      }
    }, existing);
    records[index] = next;
    await writeShardRecords(records);
    return applyFreshness(next, staleAfterMs);
  }

  async function heartbeatShard(shardId: string, healthPatch: Partial<ShardHealth> = {}): Promise<ShardRecord | null> {
    const existing = await getShard(shardId);
    if (!existing) {
      logger.warn?.(`[ShardRegistry] Heartbeat ignored for unknown shard: ${shardId}`);
      return null;
    }
    return updateShard(shardId, {
      health: {
        ...existing.health,
        ...healthPatch,
        status: normalizeStatus(healthPatch.status || existing.health.status || 'online'),
        lastHeartbeatAt: new Date().toISOString()
      }
    });
  }

  async function deregisterShard(shardId: string): Promise<{ removed: boolean; shardId: string }> {
    const normalizedShardId = normalizeString(shardId);
    const records = await readShardRecords();
    const next = records.filter(record => record.shardId !== normalizedShardId);
    if (next.length === records.length) {
      return { shardId: normalizedShardId, removed: false };
    }
    await writeShardRecords(next);
    return { shardId: normalizedShardId, removed: true };
  }

  async function pruneStaleShards(now: number | Date = Date.now()): Promise<ShardRecord[]> {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const records = await readShardRecords();
    let changed = false;
    const next = records.map(record => {
      const heartbeatTime = record.health.lastHeartbeatAt ? Date.parse(record.health.lastHeartbeatAt) : NaN;
      if (!Number.isFinite(heartbeatTime)) {
        return record;
      }
      if (nowMs - heartbeatTime <= staleAfterMs || record.health.status === 'offline' || record.health.status === 'draining') {
        return record;
      }
      changed = true;
      return normalizeRecord({
        ...record,
        health: {
          ...record.health,
          status: 'offline',
          error: record.health.error || 'Heartbeat stale'
        }
      }, record);
    });
    if (changed) {
      await writeShardRecords(next);
    }
    return next.map(record => applyFreshness(record, staleAfterMs));
  }

  async function listDeployments(filters: { bundleId?: string | null; shardId?: string | null; status?: string | null } = {}): Promise<ShardDeploymentRecord[]> {
    const bundleId = normalizeOptionalString(filters.bundleId);
    const shardId = normalizeOptionalString(filters.shardId);
    const status = normalizeOptionalString(filters.status);
    return (await readDeployments())
      .filter(record => !bundleId || record.bundleId === bundleId)
      .filter(record => !shardId || record.shardId === shardId)
      .filter(record => !status || record.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function recordDeployment(input: Partial<ShardDeploymentRecord> & { bundleId: string; shardId: string }): Promise<ShardDeploymentRecord> {
    const records = await readDeployments();
    const deploymentId = normalizeString(input.deploymentId || `${input.shardId}:${input.bundleId}`);
    const index = records.findIndex(record => record.deploymentId === deploymentId);
    const existing = index >= 0 ? records[index] : null;
    const next = normalizeDeployment({
      ...existing,
      ...input,
      deploymentId
    }, existing);
    if (index >= 0) {
      records[index] = next;
    } else {
      records.push(next);
    }
    await writeDeployments(records);
    return next;
  }

  async function updateDeployment(deploymentId: string, patch: Partial<ShardDeploymentRecord>): Promise<ShardDeploymentRecord | null> {
    const records = await readDeployments();
    const normalizedDeploymentId = normalizeString(deploymentId);
    const index = records.findIndex(record => record.deploymentId === normalizedDeploymentId);
    if (index < 0) {
      return null;
    }
    const existing = records[index];
    const next = normalizeDeployment({
      ...existing,
      ...patch,
      deploymentId: normalizedDeploymentId,
      metadata: {
        ...(existing.metadata || {}),
        ...(patch.metadata || {})
      }
    }, existing);
    records[index] = next;
    await writeDeployments(records);
    return next;
  }

  return {
    deregisterShard,
    getShard,
    heartbeatShard,
    listDeployments,
    listShards,
    pruneStaleShards,
    recordDeployment,
    registerShard,
    updateDeployment,
    updateShard
  };
}
