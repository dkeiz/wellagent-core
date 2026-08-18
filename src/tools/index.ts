// ---------------------------------------------------------------------------
// lib/tools/index.ts — Tools layer barrel export
// ---------------------------------------------------------------------------

export { ToolRegistry } from './registry';
export { ToolChain } from './chain';
export type { ChainOptions, ChainStep, ChainResult } from './chain';
export { ToolPermissions } from './permissions';
export type { PermissionCheckResult, ToolPolicy } from './permissions';
export { parseToolCalls, extractJsonObject, createToolCallId } from './parser';

// Built-in tools
export { createCoreTools } from './builtins/core';
export { createFileTools } from './builtins/file';
export { createTerminalTools } from './builtins/terminal';
export { createWebTools } from './builtins/web';
export { resolveToolSets, listToolSets } from './builtins';
