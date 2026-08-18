// ---------------------------------------------------------------------------
// lib/bundles/manifest.ts — Portable agent bundle types and validation
// ---------------------------------------------------------------------------

/** Agent bundle manifest — the portable unit. */
export interface AgentBundleManifest {
  version: 1;
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  plugins?: string[];
  pluginConfig?: Record<string, Record<string, any>>;
  toolPolicy?: AgentToolPolicy;
  metadata?: AgentBundleMetadata;
  runtimeHints?: AgentRuntimeHints;
}

export interface AgentToolPolicy {
  allowedGroups?: string[];
  allowedTools?: string[];
  blockedGroups?: string[];
  blockedTools?: string[];
  allowCustomTools?: boolean;
}

export interface AgentBundleMetadata {
  author?: string;
  icon?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  source?: string;
  sourceAgentId?: number | string;
}

export interface AgentRuntimeHints {
  needsFilesystem?: boolean;
  needsTerminal?: boolean;
  needsKnowledge?: boolean;
  needsAudio?: boolean;
  needsNetwork?: boolean;
  preferredModel?: string;
  preferredProvider?: string;
  maxConcurrentTools?: number;
  maxTurns?: number;
  timeoutMs?: number;
}

/**
 * Validate a bundle manifest.
 * Returns errors — empty array means valid.
 */
export function validateManifest(manifest: any): string[] {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return ['Manifest must be an object'];
  }

  if (manifest.version !== 1) errors.push('version must be 1');
  if (!manifest.id || typeof manifest.id !== 'string') errors.push('id is required and must be a string');
  if (!manifest.name || typeof manifest.name !== 'string') errors.push('name is required and must be a string');
  if (!manifest.systemPrompt || typeof manifest.systemPrompt !== 'string') {
    errors.push('systemPrompt is required and must be a string');
  }

  if (manifest.plugins && !Array.isArray(manifest.plugins)) {
    errors.push('plugins must be an array');
  }

  return errors;
}

/**
 * Create a blank bundle manifest with required fields.
 */
export function createManifest(
  overrides: Partial<AgentBundleManifest> & { name: string; systemPrompt: string }
): AgentBundleManifest {
  return {
    version: 1,
    id: overrides.id || `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: overrides.name,
    description: overrides.description,
    systemPrompt: overrides.systemPrompt,
    plugins: overrides.plugins || [],
    pluginConfig: overrides.pluginConfig,
    toolPolicy: overrides.toolPolicy,
    metadata: {
      createdAt: new Date().toISOString(),
      ...overrides.metadata,
    },
    runtimeHints: overrides.runtimeHints,
  };
}
