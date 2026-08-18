// ---------------------------------------------------------------------------
// lib/bundles/exporter.ts — Export agent → portable bundle
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import type { AgentManager, Agent } from '../agents/manager';
import type { AgentBundleManifest, AgentRuntimeHints } from './manifest';
import { createManifest } from './manifest';
import type { Logger } from '../core/types';

export interface ExportOptions {
  agentId: number;
  includePluginConfig?: boolean;
  includeRuntimeHints?: boolean;
  outputPath?: string;
}

export interface ExportResult {
  success: boolean;
  manifest?: AgentBundleManifest;
  outputPath?: string;
  error?: string;
}

/**
 * Export an agent definition to a portable bundle manifest.
 *
 * Usage:
 * ```typescript
 * const result = await exportBundle(agentManager, {
 *   agentId: 1,
 *   outputPath: './bundles/my-agent.json',
 * });
 * ```
 */
export async function exportBundle(
  agentManager: AgentManager,
  options: ExportOptions,
  logger: Logger = console,
): Promise<ExportResult> {
  const agent = await agentManager.get(options.agentId);
  if (!agent) {
    return { success: false, error: `Agent ${options.agentId} not found` };
  }

  const runtimeHints: AgentRuntimeHints | undefined = options.includeRuntimeHints
    ? {
        needsFilesystem: agent.tools?.some(t => ['read_file', 'write_file', 'list_dir'].includes(t)),
        needsTerminal: agent.tools?.some(t => t === 'run_command'),
        needsNetwork: agent.tools?.some(t => ['web_search', 'fetch_url'].includes(t)),
        preferredModel: agent.model,
        preferredProvider: agent.provider,
      }
    : undefined;

  const manifest = createManifest({
    name: agent.name,
    systemPrompt: agent.systemPrompt || '',
    description: agent.description,
    plugins: (agent as any).plugins,
    runtimeHints,
    metadata: {
      source: 'local-agent',
      sourceAgentId: agent.id,
      author: (agent as any).userId,
      icon: agent.icon,
      tags: [],
    },
  });

  // Write to disk if path specified
  if (options.outputPath) {
    try {
      const dir = path.dirname(options.outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(options.outputPath, JSON.stringify(manifest, null, 2), 'utf-8');
      logger.log?.(`[BundleExporter] Exported agent "${agent.name}" to ${options.outputPath}`);
    } catch (error: any) {
      return { success: false, error: `Write failed: ${error?.message}` };
    }
  }

  return { success: true, manifest, outputPath: options.outputPath };
}
