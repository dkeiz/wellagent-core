// ---------------------------------------------------------------------------
// lib/tools/builtins/index.ts — Built-in tools barrel export
// ---------------------------------------------------------------------------

export { createCoreTools } from './core';
export { createFileTools } from './file';
export { createTerminalTools } from './terminal';
export { createWebTools } from './web';

import type { ToolDefinition } from '../../core/types';
import { createCoreTools } from './core';
import { createFileTools } from './file';
import { createTerminalTools } from './terminal';
import { createWebTools } from './web';

/** Tool set name to factory mapping. */
const TOOL_SETS: Record<string, (options?: any) => ToolDefinition[]> = {
  core: createCoreTools,
  file: createFileTools,
  terminal: createTerminalTools,
  web: createWebTools,
};

/**
 * Resolve tool set names to tool definitions.
 *
 * Usage:
 * ```typescript
 * const tools = resolveToolSets(['core', 'file', 'terminal']);
 * registry.registerBatch(tools);
 * ```
 */
export function resolveToolSets(
  sets: string[],
  options?: Record<string, any>
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const name of sets) {
    const factory = TOOL_SETS[name];
    if (factory) {
      tools.push(...factory(options));
    }
  }
  return tools;
}

/**
 * List all available built-in tool set names.
 */
export function listToolSets(): string[] {
  return Object.keys(TOOL_SETS);
}
