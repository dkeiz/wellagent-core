// ---------------------------------------------------------------------------
// lib/index.ts — Public API for the composable LocalAgent library
// ---------------------------------------------------------------------------

export {
  Container,
  EventBus,
  ScopedSettingsAccessor,
  buildScopeOptions,
  cloneDeep,
  createRuntime,
  deleteScopedSetting,
  generateId,
  getScopedSetting,
  retry,
  saveScopedSetting,
  toBool,
  toInt,
  toNumber,
  toOptionalString,
  toString,
} from './core';
export type {
  AgentDefinition,
  CapabilityContract,
  ChatMessage,
  DispatchOptions,
  EventDefinition,
  LLMResponse,
  Logger,
  MemoryEntry,
  Message,
  ModelDiscoveryMeta,
  ModelSpec,
  PluginManifest,
  ProviderName,
  RequestContext,
  RequestContextSource,
  RuntimeBlueprint,
  RuntimeHandle,
  RuntimeModule,
  RuntimeModuleContext,
  ScopeOptions,
  SessionRecord,
  SettingsStore,
  TokenUsage,
  ToolCallRecord,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolHandler,
  ToolParameterProperty,
  ToolParameterSchema,
  ToolPermission,
  ToolResult,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepResult,
} from './core';

export { InMemoryDatabase, MigrationRunner, VectorStore, cosineSimilarity } from './storage';
export type {
  AgentStore,
  ChatSessionStore,
  DatabaseAdapter,
  EmbeddingProvider,
  IdentityStore,
  MemoryStore,
  Migration,
  ResourceId,
  RuntimeStorage,
  SecretStorePort,
  StorageLifecycle,
  StoredAgent,
  StoredWorkflow,
  VectorDocument,
  VectorSearchResult,
  WorkflowStore,
} from './storage';

export {
  ConversationContextCache,
  Dispatcher,
  InferenceScheduler,
  LMStudioAdapter,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  OpenRouterAdapter,
  ProcessEngine,
  Provider,
  QwenAdapter,
  buildContext,
  buildSystemPrompt,
  estimateMessageTokens,
  estimateTokens,
  estimateUsage,
  formatToolDescriptions,
  normalizeMessage,
  normalizeMessages,
} from './inference';
export type {
  ContextResult,
  EngineStatus,
  MessageCleaners,
  ProcessEngineOptions,
  PromptBuildOptions,
  ProviderCallOptions,
  SchedulingDecision,
  UsageEstimate,
} from './inference';

export {
  ToolChain,
  ToolPermissions,
  ToolRegistry,
  createCoreTools,
  createToolCallId,
  extractJsonObject,
  parseToolCalls,
} from './tools';
export type { ChainOptions, ChainResult, ChainStep, PermissionCheckResult, ToolPolicy } from './tools';

export { AgentLoop, AgentManager, AgentMemory, AgentRoom, SubagentRuntime } from './agents';
export type { Agent, RoomParticipant, RoomRoundResult, SubagentConfig, SubagentResult } from './agents';

export { WorkflowManager, WorkflowRuntime, WorkflowScheduler } from './workflows';
export type { Workflow } from './workflows';

export { createManifest, validateManifest } from './bundles';
export type { AgentBundleManifest, AgentBundleMetadata, AgentRuntimeHints, AgentToolPolicy } from './bundles';

export { Runtime } from './runtime';
export type { RuntimeOptions } from './runtime';

/** Risky transports, code loading, UI helpers, and persistence adapters. */
export * as extensions from './extensions';
