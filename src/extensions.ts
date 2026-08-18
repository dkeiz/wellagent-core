// ---------------------------------------------------------------------------
// lib/extensions.ts — Explicit opt-in capabilities outside the core runtime
// ---------------------------------------------------------------------------

export { FileMemoryStore } from './agents/file-memory-store';
export { createFileTools, createTerminalTools, createWebTools } from './tools';

export { PluginManager, ContractRegistry, BUILTIN_CONTRACTS } from './plugins';
export type { LoadedPluginModule, PluginExecutionPolicy, PluginModuleLoader } from './plugins/manager';

export { ConnectorRuntime } from './connectors';
export type { ConnectorHandle, ConnectorHost } from './connectors/runtime';

export { GatewayServer, createTunnel } from './gateway';
export type { TunnelConfig, TunnelHandle, TunnelProcess, TunnelProvider, TunnelRunner } from './gateway/tunnel';

export { A2AManager, A2AClient, A2AServer } from './a2a';
export type {
  A2AAgentCard, A2ACapability, A2AMessage, A2AMessagePart, A2ATask,
  A2ATaskStatus, A2ATarget, A2AStreamEvent,
} from './a2a';

export { ShardRegistry, ShardRouter, ShardSupervisor } from './shards';
export type {
  LocalShardHostHandle, LocalShardHostOptions, RuntimeHints, ShardCapabilities,
  ShardDeploymentRecord, ShardHealth, ShardRecord, ShardRoute, ShardRouteRequest, ShardStatus,
} from './shards';

export { exportBundle, importBundle } from './bundles';
export type { ExportOptions, ExportResult, ImportResult } from './bundles';

export {
  DEFAULT_CONTRACT, SkinLoader, detectByContent, detectByFilename, detectContent,
  detectContentType, escapeHtml, formatMessage, parseCssTokens, stripFormatting,
  tokensToCss, validateThemeTokens,
} from './ui';
export type {
  ContentDetection, ContentKind, FormatOptions, LoadedSkin, ResolvedTheme,
  SkinEntry, SkinManifest, ThemeTokenContract,
} from './ui';

export * as auth from './auth';
