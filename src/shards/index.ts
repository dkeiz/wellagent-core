// ---------------------------------------------------------------------------
// lib/shards/index.ts — Shards layer barrel export
// ---------------------------------------------------------------------------

export { ShardRegistry } from './registry';
export type {
  ShardStatus, ShardCapabilities, ShardHealth,
  ShardRecord, ShardDeploymentRecord,
} from './registry';

export { ShardRouter } from './router';
export type { ShardRouteRequest, ShardRoute, RuntimeHints } from './router';

export { ShardSupervisor } from './supervisor';
export type { LocalShardHostOptions, LocalShardHostHandle } from './supervisor';
