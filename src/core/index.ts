// ---------------------------------------------------------------------------
// lib/core/index.ts — Core layer barrel export
// ---------------------------------------------------------------------------

// Types
export type {
  // Request & Scope
  RequestContext,
  RequestContextSource,
  ScopeOptions,
  SettingsStore,

  // Messages
  Message,
  ChatMessage,

  // LLM / Inference
  ProviderName,
  TokenUsage,
  LLMResponse,
  ModelDiscoveryMeta,
  ModelSpec,
  DispatchOptions,

  // Tools
  ToolDefinition,
  ToolHandler,
  ToolExecutionContext,
  ToolResult,
  ToolCallRecord,
  ToolParameterSchema,
  ToolParameterProperty,
  ToolPermission,
  ToolExecutionResult,

  // Agents
  AgentDefinition,
  MemoryEntry,
  SessionRecord,

  // Plugins
  PluginManifest,
  CapabilityContract,
  PluginInfo,

  // Workflows
  WorkflowDefinition,
  WorkflowStep,
  WorkflowRun,
  WorkflowStepResult,

  // Events
  EventDefinition,

  // Infrastructure
  Logger,
} from './types';

// Container
export { Container } from './container';

// Composition
export { createRuntime } from './composition';
export type { RuntimeBlueprint, RuntimeHandle, RuntimeModule, RuntimeModuleContext } from './composition';

// Settings
export {
  buildScopeOptions,
  getScopedSetting,
  saveScopedSetting,
  deleteScopedSetting,
  ScopedSettingsAccessor,
} from './settings';

// Events
export { EventBus } from './events';

// Config utilities
export {
  toBool,
  toNumber,
  toInt,
  toString,
  toOptionalString,
  cloneDeep,
  generateId,
  retry,
} from './config';
