// ---------------------------------------------------------------------------
// lib/bundles/importer.ts — Import portable bundle → agent
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import type { AgentManager } from '../agents/manager';
import type { AgentBundleManifest } from './manifest';
import { validateManifest } from './manifest';
import type { Logger } from '../core/types';
import type { ResourceId } from '../storage/ports';

export interface ImportResult {
  success: boolean;
  agentId?: ResourceId;
  bundleId?: string;
  error?: string;
  warnings?: string[];
}

/**
 * Import a bundle manifest and create an agent from it.
 *
 * Usage:
 * ```typescript
 * const result = await importBundle(agentManager, './bundles/my-agent.json');
 * if (result.success) console.log(`Created agent #${result.agentId}`);
 * ```
 */
export async function importBundle(
  agentManager: AgentManager,
  manifestOrPath: AgentBundleManifest | string,
  logger: Logger = console,
): Promise<ImportResult> {
  let manifest: AgentBundleManifest;

  if (typeof manifestOrPath === 'string') {
    try {
      const raw = fs.readFileSync(manifestOrPath, 'utf-8');
      manifest = JSON.parse(raw);
    } catch (error: any) {
      return { success: false, error: `Failed to read bundle: ${error?.message}` };
    }
  } else {
    manifest = manifestOrPath;
  }

  // Validate
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    return { success: false, error: `Invalid manifest: ${errors.join(', ')}` };
  }

  // Create agent
  try {
    const agent = await agentManager.create({
      name: manifest.name,
      systemPrompt: manifest.systemPrompt,
      description: manifest.description || `Imported from bundle ${manifest.id}`,
      model: manifest.runtimeHints?.preferredModel,
      provider: manifest.runtimeHints?.preferredProvider,
      tools: manifest.toolPolicy?.allowedTools,
      icon: manifest.metadata?.icon,
    });

    logger.log?.(`[BundleImporter] Imported "${manifest.name}" as agent #${agent.id}`);

    const warnings: string[] = [];
    if (manifest.plugins?.length) {
      warnings.push(`Bundle requires plugins: ${manifest.plugins.join(', ')}. Ensure they are installed.`);
    }

    return {
      success: true,
      agentId: agent.id,
      bundleId: manifest.id,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error: any) {
    return { success: false, error: `Agent creation failed: ${error?.message}` };
  }
}
