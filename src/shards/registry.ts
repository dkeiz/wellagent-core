// ---------------------------------------------------------------------------
// lib/shards/registry.ts — Shard registration and lifecycle
// ---------------------------------------------------------------------------

import type { SettingsStore, Logger } from '../core/types';
import { ScopedSettingsAccessor } from '../core/settings';

// ---- Types ----

export type ShardStatus = 'unknown' | 'online' | 'degraded' | 'offline' | 'draining';

export interface ShardCapabilities {
  filesystem?: boolean;
  terminal?: boolean;
  knowledge?: boolean;
  audio?: boolean;
  network?: boolean;
  maxConcurrentAgents?: number;
  maxConcurrentTools?: number;
  supportedProviders?: string[];
  supportedModels?: string[];
  tags?: string[];
}

export interface ShardHealth {
  status: ShardStatus;
  lastHeartbeatAt?: string | null;
  heartbeatIntervalMs?: number | null;
  observedLatencyMs?: number | null;
  activeRuns?: number;
  deployedBundles?: number;
  load?: number | null;
  error?: string | null;
}

export interface ShardRecord {
  shardId: string;
  label: string;
  host: string;
  port: number;
  baseUrl?: string | null;
  authToken?: string | null;
  capabilities: ShardCapabilities;
  health: ShardHealth;
  runtime?: {
    version?: string;
    mode?: 'desktop' | 'headless' | 'shard-host';
    profileId?: string | null;
  };
  metadata?: Record<string, any>;
  registeredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShardDeploymentRecord {
  deploymentId: string;
  shardId: string;
  bundleId: string;
  bundleName: string;
  status: 'pending' | 'deployed' | 'failed' | 'removed';
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
}

const SHARDS_SETTING_KEY = 'shards.registry.v1';
const DEPLOYMENTS_SETTING_KEY = 'shards.deployments.v1';
const DEFAULT_STALE_AFTER_MS = 120000;

/**
 * Manages shard registrations — register, heartbeat, prune stale, list.
 *
 * Shards are remote (or local) nodes that can execute agent bundles.
 * Each shard announces its capabilities and health via heartbeats.
 *
 * Usage:
 * ```typescript
 * const registry = new ShardRegistry(db);
 * await registry.registerShard({ shardId: 'shard-1', host: '10.0.0.5', port: 8080, ... });
 * await registry.heartbeatShard('shard-1', { status: 'online', activeRuns: 2 });
 * const shards = await registry.listShards();
 * ```
 */
export class ShardRegistry extends ScopedSettingsAccessor {
  private _shards: Map<string, ShardRecord>;
  private _deployments: Map<string, ShardDeploymentRecord>;
  private _staleAfterMs: number;
  private _logger: Logger;

  constructor(db: SettingsStore, options: { staleAfterMs?: number; logger?: Logger } = {}) {
    super(db);
    this._shards = new Map();
    this._deployments = new Map();
    this._staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this._logger = options.logger ?? console;
  }

  /**
   * Load persisted state from the settings store.
   */
  async init(): Promise<void> {
    try {
      const raw = await this._getSetting(SHARDS_SETTING_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const record of parsed) {
            if (record.shardId) this._shards.set(record.shardId, record);
          }
        }
      }
    } catch { /* cold start */ }

    try {
      const raw = await this._getSetting(DEPLOYMENTS_SETTING_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const dep of parsed) {
            if (dep.deploymentId) this._deployments.set(dep.deploymentId, dep);
          }
        }
      }
    } catch { /* cold start */ }
  }

  /**
   * Register (or update) a shard.
   */
  async registerShard(input: Partial<ShardRecord> & { shardId: string }): Promise<ShardRecord> {
    const now = new Date().toISOString();
    const existing = this._shards.get(input.shardId);

    const record: ShardRecord = {
      shardId: input.shardId,
      label: input.label || existing?.label || input.shardId,
      host: input.host || existing?.host || '127.0.0.1',
      port: input.port ?? existing?.port ?? 0,
      baseUrl: input.baseUrl ?? existing?.baseUrl ?? null,
      authToken: input.authToken ?? existing?.authToken ?? null,
      capabilities: { ...(existing?.capabilities || {}), ...(input.capabilities || {}) },
      health: { status: 'online', ...(existing?.health || {}), ...(input.health || {}), lastHeartbeatAt: now },
      runtime: { ...(existing?.runtime || {}), ...(input.runtime || {}) },
      metadata: { ...(existing?.metadata || {}), ...(input.metadata || {}) },
      registeredAt: existing?.registeredAt || now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this._shards.set(input.shardId, record);
    await this._persist();
    return record;
  }

  /**
   * Update a shard's health via heartbeat.
   */
  async heartbeatShard(shardId: string, healthPatch?: Partial<ShardHealth>): Promise<ShardRecord | null> {
    const record = this._shards.get(shardId);
    if (!record) return null;

    record.health = {
      ...record.health,
      ...(healthPatch || {}),
      lastHeartbeatAt: new Date().toISOString(),
    };
    record.updatedAt = new Date().toISOString();
    await this._persist();
    return record;
  }

  /**
   * Remove a shard.
   */
  async deregisterShard(shardId: string): Promise<{ removed: boolean; shardId: string }> {
    const removed = this._shards.delete(shardId);
    if (removed) await this._persist();
    return { removed, shardId };
  }

  /**
   * Get a shard by ID.
   */
  async getShard(shardId: string): Promise<ShardRecord | null> {
    return this._shards.get(shardId) ?? null;
  }

  /**
   * List all shards.
   */
  async listShards(options: { includeOffline?: boolean } = {}): Promise<ShardRecord[]> {
    const all = Array.from(this._shards.values());
    if (options.includeOffline) return all;
    return all.filter(s => s.health.status !== 'offline');
  }

  /**
   * Prune shards that haven't heartbeated within the stale threshold.
   */
  async pruneStaleShards(now?: number | Date): Promise<ShardRecord[]> {
    const threshold = (now instanceof Date ? now.getTime() : (now || Date.now())) - this._staleAfterMs;
    const pruned: ShardRecord[] = [];

    for (const record of this._shards.values()) {
      const lastBeat = record.health.lastHeartbeatAt
        ? new Date(record.health.lastHeartbeatAt).getTime()
        : 0;
      if (lastBeat < threshold) {
        record.health.status = 'offline';
        pruned.push(record);
      }
    }

    if (pruned.length > 0) await this._persist();
    return pruned;
  }

  /**
   * Record a bundle deployment to a shard.
   */
  async recordDeployment(
    input: Partial<ShardDeploymentRecord> & { bundleId: string; shardId: string }
  ): Promise<ShardDeploymentRecord> {
    const now = new Date().toISOString();
    const id = input.deploymentId || `dep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const record: ShardDeploymentRecord = {
      deploymentId: id,
      shardId: input.shardId,
      bundleId: input.bundleId,
      bundleName: input.bundleName || input.bundleId,
      status: input.status || 'pending',
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };
    this._deployments.set(id, record);
    await this._persist();
    return record;
  }

  /**
   * List deployments, optionally filtered.
   */
  async listDeployments(filters?: {
    bundleId?: string | null;
    shardId?: string | null;
    status?: string | null;
  }): Promise<ShardDeploymentRecord[]> {
    let all = Array.from(this._deployments.values());
    if (filters?.bundleId) all = all.filter(d => d.bundleId === filters.bundleId);
    if (filters?.shardId) all = all.filter(d => d.shardId === filters.shardId);
    if (filters?.status) all = all.filter(d => d.status === filters.status);
    return all;
  }

  private async _persist(): Promise<void> {
    try {
      await this._saveSetting(SHARDS_SETTING_KEY, JSON.stringify(Array.from(this._shards.values())));
      await this._saveSetting(DEPLOYMENTS_SETTING_KEY, JSON.stringify(Array.from(this._deployments.values())));
    } catch (error: any) {
      this._logger.warn?.('[ShardRegistry] Persist failed:', error?.message);
    }
  }
}
