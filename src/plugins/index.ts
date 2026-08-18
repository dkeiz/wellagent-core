// ---------------------------------------------------------------------------
// lib/plugins/index.ts — Plugins layer barrel export
// ---------------------------------------------------------------------------

export { PluginManager } from './manager';
export type { LoadedPluginModule, PluginExecutionPolicy, PluginModuleLoader } from './manager';
export { ContractRegistry, BUILTIN_CONTRACTS } from './contracts';
