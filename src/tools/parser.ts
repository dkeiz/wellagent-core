// ---------------------------------------------------------------------------
// lib/tools/parser.ts — Tool call parser
// ---------------------------------------------------------------------------

import type { ToolCallRecord, Logger } from '../core/types';

/**
 * Generate a unique tool call ID.
 */
export function createToolCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Extract a JSON object from text, handling code fences and Windows path escaping.
 */
export function extractJsonObject(text: string): { ok: boolean; params?: Record<string, any>; reason?: string } {
  let candidate = String(text || '').trimStart();
  if (!candidate) return { ok: false, reason: 'missing_params_json' };

  // Strip code fences
  if (candidate.startsWith('```')) {
    const firstNewline = candidate.indexOf('\n');
    if (firstNewline !== -1) {
      candidate = candidate.slice(firstNewline + 1).trimStart();
      const fenceEnd = candidate.indexOf('```');
      if (fenceEnd !== -1) candidate = candidate.slice(0, fenceEnd).trim();
    }
  }

  const jsonStart = candidate.indexOf('{');
  if (jsonStart === -1) return { ok: false, reason: 'missing_json_object' };
  candidate = candidate.slice(jsonStart);

  // Balanced-brace extraction
  let depth = 0;
  let end = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < candidate.length; i++) {
    const char = candidate[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"' && !escapeNext) { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
  }

  if (end === 0) return { ok: false, reason: 'unclosed_json_object' };

  const slice = candidate.slice(0, end);
  let params: any;

  try {
    params = JSON.parse(slice);
  } catch {
    // Attempt Windows path repair
    const repaired = repairWindowsPaths(slice);
    if (!repaired) return { ok: false, reason: 'invalid_json' };
    try {
      params = JSON.parse(repaired);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
  }

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, reason: 'params_not_object' };
  }

  return { ok: true, params };
}

/**
 * Attempt to repair unescaped backslashes in JSON (common with Windows paths).
 */
function repairWindowsPaths(jsonText: string): string | null {
  const input = String(jsonText || '');
  if (!input.includes('\\')) return null;

  let output = '';
  let changed = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== '"') { output += ch; continue; }

    output += ch;
    i++;
    let raw = '';
    let escaped = false;

    for (; i < input.length; i++) {
      const cur = input[i];
      if (!escaped && cur === '"') break;
      raw += cur;
      escaped = cur === '\\' && !escaped;
    }

    // Escape unescaped backslashes in string values
    let repaired = '';
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j];
      if (c !== '\\') { repaired += c; continue; }
      const next = raw[j + 1] || '';
      if (/["\\/bfnrtu]/.test(next)) {
        repaired += `\\${next}`;
        j++;
      } else {
        repaired += '\\\\';
        changed = true;
      }
    }

    output += repaired;
    if (i < input.length && input[i] === '"') output += '"';
  }

  return changed ? output : null;
}

/**
 * Parse tool calls from LLM response text.
 *
 * Recognizes two patterns:
 * 1. `TOOL: tool_name { ... params ... }`
 * 2. `tool_name { ... params ... }` (loose match against known tools)
 */
export function parseToolCalls(
  text: string,
  knownTools: Set<string> | string[],
  options: { logger?: Logger } = {}
): ToolCallRecord[] {
  const source = String(text || '');
  const calls: ToolCallRecord[] = [];
  const acceptedKeys = new Set<string>();
  const tools = knownTools instanceof Set ? knownTools : new Set(knownTools);

  // Pattern 1: TOOL: name { params }
  const toolPrefix = /TOOL\s*:\s*([A-Za-z0-9_]+)/gi;
  let match;

  while ((match = toolPrefix.exec(source)) !== null) {
    const previousChar = match.index > 0 ? source[match.index - 1] : '';
    const isBoundary = !previousChar || /\s|[`"'([{<]/.test(previousChar);
    if (!isBoundary) continue;

    const toolName = match[1];
    const afterTool = source.slice(match.index + match[0].length);
    const parsed = extractJsonObject(afterTool);
    if (!parsed.ok) continue;

    const key = `${toolName}:${JSON.stringify(parsed.params)}`;
    if (acceptedKeys.has(key)) continue;
    acceptedKeys.add(key);

    calls.push({
      id: createToolCallId(),
      name: toolName,
      arguments: parsed.params!,
    });
  }

  // Pattern 2: Loose match — tool_name { params }
  for (const toolName of tools) {
    const escapedTool = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const loosePattern = new RegExp(`\\b${escapedTool}\\b`, 'gi');
    let looseMatch;

    while ((looseMatch = loosePattern.exec(source)) !== null) {
      const before = looseMatch.index > 0 ? source[looseMatch.index - 1] : '';
      if (before === ':') continue;

      const afterStart = looseMatch.index + looseMatch[0].length;
      const after = source.slice(afterStart);
      if (!/^\s*(\{|\.)/.test(after)) continue;

      const parsed = extractJsonObject(after);
      if (!parsed.ok) continue;

      const key = `${toolName}:${JSON.stringify(parsed.params)}`;
      if (acceptedKeys.has(key)) continue;
      acceptedKeys.add(key);

      calls.push({
        id: createToolCallId(),
        name: toolName,
        arguments: parsed.params!,
      });
    }
  }

  return calls;
}
