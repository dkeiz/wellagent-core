import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import type {
  AgentBundleExportOptions,
  AgentBundleImportResult,
  AgentBundleManifest,
  AgentRuntimeHints,
  RequestContext
} from '../../shared/types';

export interface AgentBundleLoaderOptions {
  db: any;
  agentManager?: any;
  pluginManager?: any;
}

export interface AgentBundleScopeOptions {
  requestContext?: RequestContext | Record<string, any> | null;
  userId?: string | null;
}

export interface AgentBundleLoader {
  exportBundle(options: AgentBundleExportOptions & AgentBundleScopeOptions): Promise<AgentBundleManifest>;
  importBundle(bundlePath: string, options?: AgentBundleScopeOptions): Promise<AgentBundleImportResult>;
  loadBundle(bundlePath: string): AgentBundleManifest;
  resolvePluginDependencies(manifest: AgentBundleManifest): { installed: string[]; missing: string[] };
  saveBundle(manifest: AgentBundleManifest, outputPath: string): string;
  validateManifest(manifest: any): { valid: boolean; errors: string[] };
}

function normalizeString(value: any): string {
  return String(value || '').trim();
}

function parseJsonObject(rawValue: any): Record<string, any> {
  if (!rawValue) return {};
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue;
  }
  try {
    const parsed = JSON.parse(String(rawValue));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function uniqueStrings(values: any[] = []): string[] {
  return Array.from(new Set(values.map(value => normalizeString(value)).filter(Boolean)));
}

function buildRuntimeHints(agent: any, config: Record<string, any>): AgentRuntimeHints {
  const type = normalizeString(agent?.type).toLowerCase();
  return {
    needsFilesystem: config.filesystem === true || type === 'pro',
    needsTerminal: config.terminal === true || config.shell === true || type === 'pro',
    needsKnowledge: config.knowledge === true,
    needsAudio: config.audio === true || config.tts === true || config.stt === true,
    needsNetwork: config.network !== false,
    preferredModel: normalizeString(config.model_override || agent?.model_override) || undefined,
    preferredProvider: normalizeString(config.provider_override || agent?.provider_override) || undefined,
    maxConcurrentTools: Number.isFinite(Number(config.maxConcurrentTools)) ? Number(config.maxConcurrentTools) : undefined,
    maxTurns: Number.isFinite(Number(config.maxTurns)) ? Number(config.maxTurns) : undefined,
    timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : undefined
  };
}

function buildBundleId(agent: any): string {
  const slug = normalizeString(agent?.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';
  return `${slug}-${crypto.createHash('sha1').update(`${agent?.id || 'unknown'}:${slug}`).digest('hex').slice(0, 10)}`;
}

function buildScopeOptions(input: AgentBundleScopeOptions = {}) {
  return {
    requestContext: input.requestContext || null,
    userId: normalizeString(input.userId) || undefined
  };
}

export function createAgentBundleLoader(options: AgentBundleLoaderOptions): AgentBundleLoader {
  const db = options?.db;
  const agentManager = options?.agentManager || null;
  const pluginManager = options?.pluginManager || null;

  if (!db) {
    throw new Error('AgentBundleLoader requires db');
  }

  async function getAgent(agentId: number | string, scopeOptions: AgentBundleScopeOptions = {}) {
    const scope = buildScopeOptions(scopeOptions);
    if (agentManager?.getAgent) {
      return agentManager.getAgent(agentId, scope);
    }
    if (db.getAgent) {
      return db.getAgent(agentId, scope);
    }
    return null;
  }

  function validateManifest(manifest: any) {
    const errors: string[] = [];
    if (!manifest || typeof manifest !== 'object') {
      errors.push('Manifest must be an object');
      return { valid: false, errors };
    }
    if (manifest.version !== 1) errors.push('Manifest version must be 1');
    if (!normalizeString(manifest.id)) errors.push('Manifest id is required');
    if (!normalizeString(manifest.name)) errors.push('Manifest name is required');
    if (!normalizeString(manifest.systemPrompt)) errors.push('Manifest systemPrompt is required');
    if (manifest.plugins && !Array.isArray(manifest.plugins)) errors.push('Manifest plugins must be an array');
    if (manifest.pluginConfig && (typeof manifest.pluginConfig !== 'object' || Array.isArray(manifest.pluginConfig))) {
      errors.push('Manifest pluginConfig must be an object');
    }
    return { valid: errors.length === 0, errors };
  }

  function loadBundle(bundlePath: string): AgentBundleManifest {
    const resolvedPath = path.resolve(String(bundlePath || ''));
    const stat = fs.statSync(resolvedPath);
    const manifestPath = stat.isDirectory() ? path.join(resolvedPath, 'agent-bundle.json') : resolvedPath;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Invalid agent bundle: ${validation.errors.join('; ')}`);
    }
    return manifest;
  }

  function saveBundle(manifest: AgentBundleManifest, outputPath: string): string {
    const resolvedPath = path.resolve(String(outputPath || ''));
    const targetDir = path.extname(resolvedPath).toLowerCase() === '.json' ? path.dirname(resolvedPath) : resolvedPath;
    const manifestPath = path.extname(resolvedPath).toLowerCase() === '.json' ? resolvedPath : path.join(targetDir, 'agent-bundle.json');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    return manifestPath;
  }

  function resolvePluginDependencies(manifest: AgentBundleManifest) {
    const requested = uniqueStrings(manifest.plugins || []);
    if (!pluginManager?.plugins || typeof pluginManager.plugins.has !== 'function') {
      return { installed: [], missing: requested };
    }
    const installed: string[] = [];
    const missing: string[] = [];
    for (const pluginId of requested) {
      if (pluginManager.plugins.has(pluginId)) {
        installed.push(pluginId);
      } else {
        missing.push(pluginId);
      }
    }
    return { installed, missing };
  }

  async function exportBundle(exportOptions: AgentBundleExportOptions & AgentBundleScopeOptions): Promise<AgentBundleManifest> {
    const scope = buildScopeOptions(exportOptions || {});
    const agent = await getAgent(exportOptions.agentId, scope);
    if (!agent) {
      throw new Error(`Agent not found: ${exportOptions.agentId}`);
    }

    const config = parseJsonObject(agent.config);
    const plugins = uniqueStrings([config.chat_ui_plugin, ...(Array.isArray(config.plugins) ? config.plugins : [])]);
    const manifest: AgentBundleManifest = {
      version: 1,
      id: buildBundleId(agent),
      name: normalizeString(agent.name) || `Agent ${agent.id}`,
      description: normalizeString(agent.description) || undefined,
      systemPrompt: normalizeString(agent.system_prompt),
      plugins,
      pluginConfig: exportOptions.includePluginConfig === true ? parseJsonObject(config.pluginConfig || config.plugin_config) : undefined,
      toolPolicy: config.toolPolicy || config.tool_policy || undefined,
      metadata: {
        createdAt: new Date().toISOString(),
        source: 'localagent',
        sourceAgentId: agent.id,
        tags: uniqueStrings([agent.type, ...(Array.isArray(config.tags) ? config.tags : [])])
      },
      runtimeHints: exportOptions.includeRuntimeHints === false ? undefined : buildRuntimeHints(agent, config)
    };

    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Failed to export bundle: ${validation.errors.join('; ')}`);
    }

    if (exportOptions.outputPath) {
      saveBundle(manifest, exportOptions.outputPath);
    }
    return manifest;
  }

  async function importBundle(bundlePath: string, importOptions: AgentBundleScopeOptions = {}): Promise<AgentBundleImportResult> {
    try {
      const manifest = loadBundle(bundlePath);
      const scope = buildScopeOptions(importOptions || {});
      const agentConfig = {
        plugins: uniqueStrings(manifest.plugins || []),
        pluginConfig: manifest.pluginConfig || {},
        toolPolicy: manifest.toolPolicy || {},
        runtimeHints: manifest.runtimeHints || {}
      };
      const agent = await db.addAgent({
        name: manifest.name,
        type: 'pro',
        icon: manifest.metadata?.icon || '🤖',
        system_prompt: manifest.systemPrompt,
        description: manifest.description || '',
        config: agentConfig,
        folder_path: ''
      }, scope);
      return {
        success: true,
        agentId: agent?.id,
        bundleId: manifest.id,
        warnings: resolvePluginDependencies(manifest).missing.map(pluginId => `Missing plugin: ${pluginId}`)
      };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  return { exportBundle, importBundle, loadBundle, resolvePluginDependencies, saveBundle, validateManifest };
}
