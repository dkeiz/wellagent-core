import type { AgentBundleManifest, AgentRuntimeHints, ShardRecord, ShardRoute } from '../../shared/types';

export interface ShardRouteRequest {
  allowFallback?: boolean;
  bundleId?: string | null;
  includeOffline?: boolean;
  preferredModel?: string | null;
  preferredProvider?: string | null;
  requiredCapabilities?: string[];
  tags?: string[];
}

export interface ShardRouterOptions {
  logger?: Pick<Console, 'warn'> | null;
  shardRegistry: any;
}

export interface ShardRouter {
  buildBundleRouteRequest(manifest: AgentBundleManifest): ShardRouteRequest;
  buildRuntimeRouteRequest(runtimeHints?: AgentRuntimeHints | null, metadata?: Record<string, any> | null): ShardRouteRequest;
  listRoutes(request: ShardRouteRequest): Promise<ShardRoute[]>;
  listRoutesForBundle(manifest: AgentBundleManifest, overrides?: Partial<ShardRouteRequest>): Promise<ShardRoute[]>;
  routeBundle(manifest: AgentBundleManifest, overrides?: Partial<ShardRouteRequest>): Promise<ShardRoute | null>;
  routeRuntimeHints(runtimeHints?: AgentRuntimeHints | null, overrides?: Partial<ShardRouteRequest>): Promise<ShardRoute | null>;
}

function normalizeString(value: any): string {
  return String(value || '').trim();
}

function uniqueStrings(values: any[] = []): string[] {
  return Array.from(new Set(values.map(value => normalizeString(value)).filter(Boolean)));
}

function includesValue(values: string[] = [], expected: string | null = null): boolean {
  if (!expected) {
    return false;
  }
  const normalizedExpected = normalizeString(expected).toLowerCase();
  return values.some(value => normalizeString(value).toLowerCase() === normalizedExpected);
}

function extractRequiredCapabilities(runtimeHints: AgentRuntimeHints | null = null): string[] {
  const hints = runtimeHints || {};
  const required: string[] = [];
  if (hints.needsFilesystem) required.push('filesystem');
  if (hints.needsTerminal) required.push('terminal');
  if (hints.needsKnowledge) required.push('knowledge');
  if (hints.needsAudio) required.push('audio');
  if (hints.needsNetwork) required.push('network');
  return uniqueStrings(required);
}

function buildBundleTags(manifest: AgentBundleManifest): string[] {
  return uniqueStrings([
    ...(Array.isArray(manifest.plugins) ? manifest.plugins : []),
    ...(Array.isArray(manifest.metadata?.tags) ? manifest.metadata?.tags : [])
  ]);
}

function scoreShard(shard: ShardRecord, request: ShardRouteRequest): ShardRoute {
  const reasons: string[] = [];
  const missingCapabilities: string[] = [];
  const requiredCapabilities = uniqueStrings(request.requiredCapabilities || []);
  const shardTags = uniqueStrings(shard.capabilities?.tags || []);
  let score = 100;

  for (const capability of requiredCapabilities) {
    if ((shard.capabilities as Record<string, any> | undefined)?.[capability] !== true) {
      missingCapabilities.push(capability);
      score -= 250;
    }
  }

  switch (shard.health.status) {
    case 'online':
      reasons.push('status:online');
      break;
    case 'degraded':
      score -= 15;
      reasons.push('status:degraded');
      break;
    case 'draining':
      score -= 120;
      reasons.push('status:draining');
      break;
    case 'offline':
      score -= 500;
      reasons.push('status:offline');
      break;
    default:
      score -= 10;
      reasons.push('status:unknown');
      break;
  }

  const load = Number(shard.health.load);
  if (Number.isFinite(load)) {
    score -= Math.max(0, Math.min(40, load * 40));
    reasons.push(`load:${load.toFixed(2)}`);
  }

  const activeRuns = Number(shard.health.activeRuns);
  const maxConcurrentAgents = Number(shard.capabilities.maxConcurrentAgents);
  if (Number.isFinite(activeRuns) && Number.isFinite(maxConcurrentAgents) && maxConcurrentAgents > 0) {
    const utilization = activeRuns / maxConcurrentAgents;
    score -= Math.max(0, Math.min(35, utilization * 35));
    reasons.push(`utilization:${utilization.toFixed(2)}`);
  }

  if (request.preferredProvider) {
    const providers = uniqueStrings(shard.capabilities.supportedProviders || []);
    if (providers.length > 0 && includesValue(providers, request.preferredProvider)) {
      score += 10;
      reasons.push(`provider:${request.preferredProvider}`);
    } else if (providers.length > 0) {
      score -= 20;
      reasons.push(`provider-mismatch:${request.preferredProvider}`);
    }
  }

  if (request.preferredModel) {
    const models = uniqueStrings(shard.capabilities.supportedModels || []);
    if (models.length > 0 && includesValue(models, request.preferredModel)) {
      score += 10;
      reasons.push(`model:${request.preferredModel}`);
    } else if (models.length > 0) {
      score -= 15;
      reasons.push(`model-mismatch:${request.preferredModel}`);
    }
  }

  const requestedTags = uniqueStrings(request.tags || []);
  if (requestedTags.length > 0 && shardTags.length > 0) {
    const matchingTags = requestedTags.filter(tag => includesValue(shardTags, tag));
    if (matchingTags.length > 0) {
      score += Math.min(12, matchingTags.length * 4);
      reasons.push(`tags:${matchingTags.join(',')}`);
    }
  }

  if (missingCapabilities.length > 0) {
    reasons.push(`missing:${missingCapabilities.join(',')}`);
  }

  return {
    shardId: shard.shardId,
    score,
    reasons,
    requiredCapabilities,
    missingCapabilities,
    bundleId: request.bundleId || null
  };
}

function pickRoutableCandidate(routes: ShardRoute[], allowFallback: boolean): ShardRoute | null {
  for (const route of routes) {
    const offline = route.reasons.includes('status:offline');
    const draining = route.reasons.includes('status:draining');
    if (!offline && !draining && route.missingCapabilities.length === 0) {
      return route;
    }
  }
  return allowFallback ? (routes[0] || null) : null;
}

export function createShardRouter(options: ShardRouterOptions): ShardRouter {
  const shardRegistry = options?.shardRegistry;
  const logger = options?.logger || console;

  if (!shardRegistry?.listShards) {
    throw new Error('ShardRouter requires shardRegistry');
  }

  function buildRuntimeRouteRequest(runtimeHints: AgentRuntimeHints | null = null, metadata: Record<string, any> | null = null): ShardRouteRequest {
    return {
      allowFallback: false,
      requiredCapabilities: extractRequiredCapabilities(runtimeHints),
      preferredProvider: normalizeString(runtimeHints?.preferredProvider),
      preferredModel: normalizeString(runtimeHints?.preferredModel),
      tags: uniqueStrings(Array.isArray(metadata?.tags) ? metadata?.tags : []),
      includeOffline: false
    };
  }

  function buildBundleRouteRequest(manifest: AgentBundleManifest): ShardRouteRequest {
    return {
      ...buildRuntimeRouteRequest(manifest.runtimeHints || null, manifest.metadata || null),
      bundleId: normalizeString(manifest.id) || null,
      tags: buildBundleTags(manifest)
    };
  }

  async function listRoutes(request: ShardRouteRequest): Promise<ShardRoute[]> {
    const shards: ShardRecord[] = await shardRegistry.listShards({ includeOffline: request.includeOffline === true });
    if (shards.length === 0) {
      logger.warn?.('[ShardRouter] No registered shards available for routing');
      return [];
    }
    return shards
      .map((shard: ShardRecord) => scoreShard(shard, request))
      .sort((left, right) => right.score - left.score || left.shardId.localeCompare(right.shardId));
  }

  async function listRoutesForBundle(manifest: AgentBundleManifest, overrides: Partial<ShardRouteRequest> = {}): Promise<ShardRoute[]> {
    return listRoutes({
      ...buildBundleRouteRequest(manifest),
      ...overrides,
      requiredCapabilities: uniqueStrings([
        ...extractRequiredCapabilities(manifest.runtimeHints || null),
        ...(overrides.requiredCapabilities || [])
      ]),
      tags: uniqueStrings([...(buildBundleTags(manifest) || []), ...(overrides.tags || [])])
    });
  }

  async function routeBundle(manifest: AgentBundleManifest, overrides: Partial<ShardRouteRequest> = {}): Promise<ShardRoute | null> {
    const request = {
      ...buildBundleRouteRequest(manifest),
      ...overrides,
      allowFallback: overrides.allowFallback === true
    };
    const routes = await listRoutesForBundle(manifest, request);
    return pickRoutableCandidate(routes, request.allowFallback === true);
  }

  async function routeRuntimeHints(runtimeHints: AgentRuntimeHints | null = null, overrides: Partial<ShardRouteRequest> = {}): Promise<ShardRoute | null> {
    const request = {
      ...buildRuntimeRouteRequest(runtimeHints || null, null),
      ...overrides,
      allowFallback: overrides.allowFallback === true,
      requiredCapabilities: uniqueStrings([
        ...extractRequiredCapabilities(runtimeHints || null),
        ...(overrides.requiredCapabilities || [])
      ])
    };
    const routes = await listRoutes(request);
    return pickRoutableCandidate(routes, request.allowFallback === true);
  }

  return {
    buildBundleRouteRequest,
    buildRuntimeRouteRequest,
    listRoutes,
    listRoutesForBundle,
    routeBundle,
    routeRuntimeHints
  };
}
