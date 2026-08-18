// --- Portable agent bundle types (Stage 3.1) ---

export interface AgentBundleManifest {
  /** Schema version for forward compatibility */
  version: 1;

  /** Unique identifier for this agent bundle */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this agent does */
  description?: string;

  /** System prompt — the core agent behavior */
  systemPrompt: string;

  /** Plugin IDs this agent requires */
  plugins?: string[];

  /** Plugin-specific configuration overrides */
  pluginConfig?: Record<string, Record<string, any>>;

  /** Tool/capability policy */
  toolPolicy?: AgentToolPolicy;

  /** Metadata */
  metadata?: AgentBundleMetadata;

  /** Runtime hints for the host environment */
  runtimeHints?: AgentRuntimeHints;
}

export interface AgentToolPolicy {
  /** Tool groups this agent is allowed to use */
  allowedGroups?: string[];

  /** Specific tools this agent is allowed to use */
  allowedTools?: string[];

  /** Tool groups this agent is blocked from */
  blockedGroups?: string[];

  /** Specific tools this agent is blocked from */
  blockedTools?: string[];

  /** Whether this agent can execute custom/dynamic tools */
  allowCustomTools?: boolean;
}

export interface AgentBundleMetadata {
  /** Author or creator */
  author?: string;

  /** Icon URL or base64 */
  icon?: string;

  /** Category tags */
  tags?: string[];

  /** Created timestamp */
  createdAt?: string;

  /** Last modified timestamp */
  updatedAt?: string;

  /** Source (where this bundle came from) */
  source?: string;

  /** Original agent ID in the source system */
  sourceAgentId?: number | string;
}

export interface AgentRuntimeHints {
  /** Agent needs filesystem access */
  needsFilesystem?: boolean;

  /** Agent needs terminal/shell access */
  needsTerminal?: boolean;

  /** Agent needs knowledge/RAG access */
  needsKnowledge?: boolean;

  /** Agent needs audio/TTS/STT */
  needsAudio?: boolean;

  /** Agent needs network/web access */
  needsNetwork?: boolean;

  /** Agent needs a specific model or provider */
  preferredModel?: string;
  preferredProvider?: string;

  /** Maximum concurrent tool executions */
  maxConcurrentTools?: number;

  /** Maximum inference turns per invocation */
  maxTurns?: number;

  /** Timeout for the entire agent invocation in ms */
  timeoutMs?: number;
}

export interface AgentBundleExportOptions {
  agentId: number;
  includePluginConfig?: boolean;
  includeRuntimeHints?: boolean;
  outputPath?: string;
}

export interface AgentBundleImportResult {
  success: boolean;
  agentId?: number;
  bundleId?: string;
  error?: string;
  warnings?: string[];
}
