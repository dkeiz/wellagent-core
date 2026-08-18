// ---------------------------------------------------------------------------
// lib/shards/supervisor.ts — Local shard host lifecycle
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import type { ShardRegistry, ShardRecord, ShardHealth, ShardCapabilities } from './registry';
import type { Logger } from '../core/types';

/** Configuration for hosting a local shard. */
export interface LocalShardHostOptions {
  shardId?: string;
  label?: string;
  host?: string;
  port?: number;
  baseUrl?: string | null;
  authToken?: string | null;
  capabilities?: ShardCapabilities;
  mode?: 'desktop' | 'headless' | 'shard-host';
  version?: string;
  heartbeatIntervalMs?: number;
  metadata?: Record<string, any>;
  getHealth?: () => Promise<Partial<ShardHealth> | null> | Partial<ShardHealth> | null;
}

/** Handle to a running local shard host. */
export interface LocalShardHostHandle {
  shardId: string;
  stop: () => Promise<void>;
}

/**
 * Manages a local shard host — registers with a ShardRegistry,
 * sends periodic heartbeats, and handles shutdown.
 *
 * Usage:
 * ```typescript
 * const supervisor = new ShardSupervisor(registry);
 * const handle = await supervisor.startLocalHost({
 *   label: 'My Desktop',
 *   port: 8080,
 *   capabilities: { filesystem: true, terminal: true },
 * });
 * // ... later
 * await handle.stop();
 * ```
 */
export class ShardSupervisor extends EventEmitter {
  private _registry: ShardRegistry;
  private _activeHosts: Map<string, { timer: ReturnType<typeof setInterval>; options: LocalShardHostOptions }>;
  private _logger: Logger;

  constructor(registry: ShardRegistry, options: { logger?: Logger } = {}) {
    super();
    this._registry = registry;
    this._activeHosts = new Map();
    this._logger = options.logger ?? console;
  }

  /**
   * Start a local shard host.
   */
  async startLocalHost(options: LocalShardHostOptions): Promise<LocalShardHostHandle> {
    const shardId = options.shardId || `shard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const intervalMs = options.heartbeatIntervalMs ?? 30000;

    // Register
    await this._registry.registerShard({
      shardId,
      label: options.label || shardId,
      host: options.host || '127.0.0.1',
      port: options.port ?? 0,
      baseUrl: options.baseUrl,
      authToken: options.authToken,
      capabilities: options.capabilities || {},
      health: { status: 'online' },
      runtime: {
        version: options.version,
        mode: options.mode || 'desktop',
      },
      metadata: options.metadata,
    });

    // Heartbeat loop
    const timer = setInterval(async () => {
      try {
        let healthPatch: Partial<ShardHealth> = { status: 'online' };
        if (options.getHealth) {
          const custom = await options.getHealth();
          if (custom) healthPatch = { ...healthPatch, ...custom };
        }
        await this._registry.heartbeatShard(shardId, healthPatch);
      } catch (error: any) {
        this._logger.warn?.(`[ShardSupervisor] Heartbeat failed for ${shardId}:`, error?.message);
      }
    }, intervalMs);

    this._activeHosts.set(shardId, { timer, options });
    this.emit('shard:started', { shardId });
    this._logger.log?.(`[ShardSupervisor] Local shard "${shardId}" started`);

    const handle: LocalShardHostHandle = {
      shardId,
      stop: async () => {
        clearInterval(timer);
        this._activeHosts.delete(shardId);
        await this._registry.heartbeatShard(shardId, { status: 'offline' });
        this.emit('shard:stopped', { shardId });
        this._logger.log?.(`[ShardSupervisor] Local shard "${shardId}" stopped`);
      },
    };

    return handle;
  }

  /**
   * Stop all local shard hosts.
   */
  async stopAll(): Promise<void> {
    for (const [shardId, { timer }] of this._activeHosts) {
      clearInterval(timer);
      await this._registry.heartbeatShard(shardId, { status: 'offline' });
    }
    this._activeHosts.clear();
  }

  /**
   * Get IDs of active local hosts.
   */
  getActiveHosts(): string[] {
    return Array.from(this._activeHosts.keys());
  }
}
