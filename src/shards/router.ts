// ---------------------------------------------------------------------------
// lib/shards/router.ts — Capability-based shard routing
// ---------------------------------------------------------------------------

import type { ShardRegistry, ShardRecord, ShardCapabilities } from './registry';
import type { Logger } from '../core/types';

/** Route request specifying what a shard must support. */
export interface ShardRouteRequest {
  requiredCapabilities?: string[];
  preferredProvider?: string | null;
  preferredModel?: string | null;
  tags?: string[];
  bundleId?: string | null;
  includeOffline?: boolean;
  allowFallback?: boolean;
}

/** Scored route result. */
export interface ShardRoute {
  shardId: string;
  score: number;
  reasons: string[];
  requiredCapabilities: string[];
  missingCapabilities: string[];
  bundleId?: string | null;
}

/** Runtime hints from a bundle manifest. */
export interface RuntimeHints {
  needsFilesystem?: boolean;
  needsTerminal?: boolean;
  needsKnowledge?: boolean;
  needsAudio?: boolean;
  needsNetwork?: boolean;
  preferredModel?: string;
  preferredProvider?: string;
}

/**
 * Routes agent work to the best-matching shard based on capabilities.
 *
 * Scoring:
 * - +10 per matched capability
 * - -100 per missing required capability
 * - +5 for preferred provider/model match
 * - +2 per matching tag
 * - -20 for degraded status, -1000 for offline
 *
 * Usage:
 * ```typescript
 * const router = new ShardRouter(registry);
 * const best = await router.route({
 *   requiredCapabilities: ['filesystem', 'terminal'],
 *   preferredProvider: 'ollama',
 * });
 * if (best) console.log(`Route to shard ${best.shardId} (score ${best.score})`);
 * ```
 */
export class ShardRouter {
  private _registry: ShardRegistry;
  private _logger: Logger;

  constructor(registry: ShardRegistry, options: { logger?: Logger } = {}) {
    this._registry = registry;
    this._logger = options.logger ?? console;
  }

  /**
   * Extract required capabilities from runtime hints.
   */
  buildRouteRequest(hints?: RuntimeHints | null): ShardRouteRequest {
    const required: string[] = [];
    if (hints?.needsFilesystem) required.push('filesystem');
    if (hints?.needsTerminal) required.push('terminal');
    if (hints?.needsKnowledge) required.push('knowledge');
    if (hints?.needsAudio) required.push('audio');
    if (hints?.needsNetwork) required.push('network');
    return {
      requiredCapabilities: required,
      preferredProvider: hints?.preferredProvider || null,
      preferredModel: hints?.preferredModel || null,
    };
  }

  /**
   * Score and rank all shards for a request.
   */
  async listRoutes(request: ShardRouteRequest): Promise<ShardRoute[]> {
    const shards = await this._registry.listShards({ includeOffline: request.includeOffline });
    const routes: ShardRoute[] = [];

    for (const shard of shards) {
      const route = this._scoreShard(shard, request);
      routes.push(route);
    }

    return routes.sort((a, b) => b.score - a.score);
  }

  /**
   * Get the best route for a request.
   */
  async route(request: ShardRouteRequest): Promise<ShardRoute | null> {
    const routes = await this.listRoutes(request);
    if (routes.length === 0) return null;

    const best = routes[0];

    // Reject if missing required capabilities (unless fallback allowed)
    if (best.missingCapabilities.length > 0 && !request.allowFallback) {
      return null;
    }

    return best.score > 0 ? best : (request.allowFallback ? best : null);
  }

  private _scoreShard(shard: ShardRecord, request: ShardRouteRequest): ShardRoute {
    let score = 0;
    const reasons: string[] = [];
    const required = request.requiredCapabilities || [];
    const missing: string[] = [];
    const caps = shard.capabilities || {};

    // Status penalty
    if (shard.health.status === 'offline') {
      score -= 1000;
      reasons.push('offline');
    } else if (shard.health.status === 'degraded') {
      score -= 20;
      reasons.push('degraded');
    } else if (shard.health.status === 'online') {
      score += 10;
      reasons.push('online');
    }

    // Capability matching
    const capMap: Record<string, boolean | undefined> = {
      filesystem: caps.filesystem,
      terminal: caps.terminal,
      knowledge: caps.knowledge,
      audio: caps.audio,
      network: caps.network,
    };

    for (const cap of required) {
      if (capMap[cap]) {
        score += 10;
        reasons.push(`has:${cap}`);
      } else {
        score -= 100;
        missing.push(cap);
        reasons.push(`missing:${cap}`);
      }
    }

    // Provider match
    if (request.preferredProvider && caps.supportedProviders?.length) {
      if (caps.supportedProviders.includes(request.preferredProvider)) {
        score += 5;
        reasons.push('provider-match');
      }
    }

    // Model match
    if (request.preferredModel && caps.supportedModels?.length) {
      if (caps.supportedModels.includes(request.preferredModel)) {
        score += 5;
        reasons.push('model-match');
      }
    }

    // Tag matching
    if (request.tags && caps.tags) {
      for (const tag of request.tags) {
        if (caps.tags.includes(tag)) {
          score += 2;
          reasons.push(`tag:${tag}`);
        }
      }
    }

    // Load factor
    if (shard.health.load !== null && shard.health.load !== undefined) {
      if (shard.health.load > 0.9) {
        score -= 10;
        reasons.push('high-load');
      } else if (shard.health.load < 0.3) {
        score += 3;
        reasons.push('low-load');
      }
    }

    return {
      shardId: shard.shardId,
      score,
      reasons,
      requiredCapabilities: required,
      missingCapabilities: missing,
      bundleId: request.bundleId,
    };
  }
}
