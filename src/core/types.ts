// ---------------------------------------------------------------------------
// lib/core/types.ts — Foundation types for the agent SDK
// ---------------------------------------------------------------------------

// ---- Request & Scope ----

/** Source of an incoming request — extensible via string union. */
export type RequestContextSource =
  | 'electron'
  | 'companion'
  | 'a2a'
  | 'http'
  | 'cli'
  | 'headless'
  | 'unknown'
  | string;

/** Identifies who made a request and through which channel. */
export interface RequestContext {
  source: RequestContextSource;
  userId?: string;
  profileId?: string;
  sessionId?: string;
  deviceId?: string;
  requestId?: string;
  [key: string]: any;
}

/** Scope options used to resolve user-specific / tenant-specific settings. */
export interface ScopeOptions {
  requestContext?: RequestContext | null;
  userId?: string;
}

// ---- Messages ----

/** A single message in a conversation. */
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRecord[];
  thinking?: string;
  [key: string]: any;
}

/** A stored chat message with persistence metadata. */
export interface ChatMessage extends Message {
  id?: string | number;
  sessionId?: string;
  timestamp?: string;
  hidden?: boolean;
}

// ---- LLM / Inference ----

/** Supported provider names — extensible via string union. */
export type ProviderName =
  | 'ollama'
  | 'openai'
  | 'openrouter'
  | 'qwen'
  | 'lmstudio'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'anthropic'
  | 'byok'
  | 'local-openai'
  | string;

/** Token usage counters returned by providers. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  prompt_tokens_details?: any | null;
}

/** Normalized response from an LLM provider. */
export interface LLMResponse {
  content: string;
  reasoning: string;
  model: string;
  usage: TokenUsage;
  stopped: boolean;
  context_length?: number;
  [key: string]: any;
}

/** Model discovery metadata. */
export interface ModelDiscoveryMeta {
  ok: boolean | null;
  source: string;
  authoritative: boolean;
  error: string | null;
  count: number;
  at: string | null;
}

/** Describes a specific model's capabilities and limits. */
export interface ModelSpec {
  id: string;
  name: string;
  provider: ProviderName;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
  category?: string;
  description?: string;
  capabilities?: Record<string, any>;
}

/** Options passed to inference dispatch. */
export interface DispatchOptions {
  provider?: ProviderName;
  model?: string;
  mode?: 'chat' | 'internal' | 'connector' | string;
  sessionId?: string | null;
  agentId?: number | null;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  thinkingMode?: string;
  thinkingBudget?: number;
  includeTools?: boolean;
  includeRules?: boolean;
  includeEnv?: boolean;
  preemptible?: boolean;
  concurrencyMode?: string;
  modelSpec?: ModelSpec | null;
  runtimeConfig?: Record<string, any> | null;
  requestContext?: RequestContext | null;
  userId?: string;
  signal?: AbortSignal;
  [key: string]: any;
}

// ---- Tools ----

/** Schema for a single tool parameter property. */
export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: any;
  items?: ToolParameterProperty;
}

/** JSON Schema–style parameter definition for a tool. */
export interface ToolParameterSchema {
  type: 'object';
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

/** Definition of a tool that can be registered and invoked. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: ToolParameterSchema;
  handler: ToolHandler;
  group?: string;
  category?: string;
  safe?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  source?: 'builtin' | 'plugin' | 'custom' | 'proxy' | string;
  pluginId?: string;
  requiresConfirmation?: boolean;
}

/** Handler function for a tool. */
export type ToolHandler = (
  params: Record<string, any>,
  context: ToolExecutionContext
) => Promise<ToolResult> | ToolResult;

/** Runtime context provided to tool handlers during execution. */
export interface ToolExecutionContext {
  sessionId?: string | null;
  agentId?: number | null;
  agentName?: string;
  runId?: string | null;
  userId?: string;
  source?: string;
  principal?: any;
  requestContext?: RequestContext | null;
  runtimePolicy?: any;
  isSubagent?: boolean;
  delegationDepth?: number;
  [key: string]: any;
}

/** Result returned by a tool handler. */
export interface ToolResult {
  content?: string;
  result?: any;
  error?: string;
  isError?: boolean;
  metadata?: Record<string, any>;
}

/** Parsed tool call extracted from an LLM response. */
export interface ToolCallRecord {
  id?: string;
  name: string;
  arguments: Record<string, any> | string;
}

/** Tool permission grant/denial. */
export interface ToolPermission {
  toolName: string;
  allowed: boolean;
  reason?: string;
  grantedBy?: string;
  expiresAt?: string;
}

/** Result of a tool execution including timing and permission info. */
export interface ToolExecutionResult {
  toolName: string;
  result: ToolResult;
  durationMs?: number;
  permitted: boolean;
  error?: string;
}

// ---- Agents ----

/** Definition of a named agent. */
export interface AgentDefinition {
  id?: string | number;
  name: string;
  systemPrompt?: string;
  description?: string;
  model?: string;
  provider?: ProviderName;
  tools?: string[];
  memory?: boolean;
  autoMemory?: boolean;
  greeting?: string;
  icon?: string;
  color?: string;
  [key: string]: any;
}

/** A stored memory entry. */
export interface MemoryEntry {
  id?: string;
  content: string;
  type?: 'conversation' | 'fact' | 'preference' | 'consolidated' | string;
  source?: string;
  sessionId?: string;
  agentId?: number;
  timestamp?: string;
  metadata?: Record<string, any>;
}

// ---- Sessions ----

/** Session record stored in the database. */
export interface SessionRecord {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
  agentId?: number | null;
  messageCount?: number;
  [key: string]: any;
}

// ---- Plugins ----

/** Plugin manifest loaded from plugin.json. */
export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  main?: string;
  capabilities?: string[];
  capabilityContracts?: Record<string, any>;
  handlers?: string[];
  settings?: Record<string, any>;
  [key: string]: any;
}

/** Versioned capability contract for plugin features. */
export interface CapabilityContract {
  id: string;
  capability: string;
  version: number;
  actions: string[];
}

/** Runtime state of a loaded plugin. */
export interface PluginInfo {
  id: string;
  manifest: PluginManifest;
  status: 'enabled' | 'disabled' | 'error' | string;
  error?: string;
}

// ---- Workflows ----

/** Definition of a workflow (series of steps). */
export interface WorkflowDefinition {
  id?: number | string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  schedule?: string;
  enabled?: boolean;
  [key: string]: any;
}

/** A single step in a workflow. */
export interface WorkflowStep {
  id?: string;
  type?: 'tool' | 'prompt' | 'condition' | string;
  tool?: string;
  prompt?: string;
  params?: Record<string, any>;
  condition?: string;
  onSuccess?: string;
  onFailure?: string;
  [key: string]: any;
}

/** Record of a workflow execution run. */
export interface WorkflowRun {
  id: string;
  workflowId: number | string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  startedAt?: string;
  completedAt?: string;
  result?: any;
  error?: string;
  steps?: WorkflowStepResult[];
}

/** Result of a single workflow step execution. */
export interface WorkflowStepResult {
  stepId?: string;
  status: 'completed' | 'failed' | 'skipped' | string;
  result?: any;
  error?: string;
  durationMs?: number;
}

// ---- Events ----

/** Definition of an event in the event catalog. */
export interface EventDefinition {
  category: string;
  description?: string;
}

// ---- Database ----

/** Minimal settings store interface used by ScopedSettingsAccessor. */
export interface SettingsStore {
  getSetting(key: string): Promise<string | null> | string | null;
  saveSetting(key: string, value: string): Promise<void> | void;
  deleteSetting?(key: string): Promise<void> | void;
  getScopedSetting?(key: string, scope: ScopeOptions): Promise<string | null> | string | null;
  saveScopedSetting?(key: string, value: string, scope: ScopeOptions): Promise<void> | void;
  deleteScopedSetting?(key: string, scope: ScopeOptions): Promise<void> | void;
}

// ---- Logger ----

/** Generic logger interface — compatible with `console`. */
export interface Logger {
  log(...args: any[]): void;
  info?(...args: any[]): void;
  warn?(...args: any[]): void;
  error?(...args: any[]): void;
  debug?(...args: any[]): void;
}
