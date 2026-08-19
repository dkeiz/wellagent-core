// @ts-nocheck
function createToolCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function extractJsonObject(text) {
  let candidate = String(text || '').trimStart();
  if (!candidate) {
    return { ok: false, reason: 'missing_params_json' };
  }

  if (candidate.startsWith('```')) {
    const firstNewline = candidate.indexOf('\n');
    if (firstNewline !== -1) {
      candidate = candidate.slice(firstNewline + 1).trimStart();
      const fenceEnd = candidate.indexOf('```');
      if (fenceEnd !== -1) {
        candidate = candidate.slice(0, fenceEnd).trim();
      }
    }
  }

  const jsonStart = candidate.indexOf('{');
  if (jsonStart === -1) {
    return { ok: false, reason: 'missing_json_object' };
  }
  candidate = candidate.slice(jsonStart);

  let depth = 0;
  let end = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < candidate.length; i++) {
    const char = candidate[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
  }

  if (end === 0) {
    return { ok: false, reason: 'unclosed_json_object' };
  }

  let params;
  const candidateSlice = candidate.slice(0, end);
  try {
    params = JSON.parse(candidateSlice);
  } catch (error) {
    const repaired = repairJsonForWindowsPaths(candidateSlice);
    if (!repaired) {
      return { ok: false, reason: 'invalid_json' };
    }
    try {
      params = JSON.parse(repaired);
    } catch (_) {
      return { ok: false, reason: 'invalid_json' };
    }
  }

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, reason: 'params_not_object' };
  }

  return { ok: true, params };
}

function repairJsonForWindowsPaths(jsonText) {
  const input = String(jsonText || '');
  if (!input.includes('\\')) {
    return null;
  }
  const looksLikeWindowsPath = (value) => /^[A-Za-z]:\\/.test(value) || value.startsWith('\\\\');

  const normalizePathLiteral = (raw) => {
    let out = '';
    let localChanged = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next = raw[i + 1];
      if (next === '\\') {
        out += '\\\\';
        i++;
        continue;
      }
      out += '\\\\';
      localChanged = true;
    }
    return { out, changed: localChanged };
  };

  const normalizeGenericLiteral = (raw) => {
    let out = '';
    let localChanged = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next = raw[i + 1] || '';
      if (/["\\/bfnrtu]/.test(next)) {
        out += `\\${next}`;
        i++;
        continue;
      }
      out += '\\\\';
      localChanged = true;
    }
    return { out, changed: localChanged };
  };

  let output = '';
  let changed = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== '"') {
      output += ch;
      continue;
    }

    output += ch;
    i++;
    let raw = '';
    let escaped = false;
    for (; i < input.length; i++) {
      const cur = input[i];
      if (!escaped && cur === '"') {
        break;
      }
      raw += cur;
      if (cur === '\\' && !escaped) {
        escaped = true;
      } else {
        escaped = false;
      }
    }

    const normalizer = looksLikeWindowsPath(raw) ? normalizePathLiteral : normalizeGenericLiteral;
    const normalized = normalizer(raw);
    changed = changed || normalized.changed;
    output += normalized.out;

    if (i < input.length && input[i] === '"') {
      output += '"';
    }
  }

  return changed ? output : null;
}

function extractLooseKeyValueObject(text) {
  let candidate = String(text || '').trimStart();
  if (!candidate) {
    return { ok: false, reason: 'missing_loose_params' };
  }

  if (candidate.startsWith('```')) {
    const firstNewline = candidate.indexOf('\n');
    if (firstNewline !== -1) {
      candidate = candidate.slice(firstNewline + 1).trimStart();
      const fenceEnd = candidate.indexOf('```');
      if (fenceEnd !== -1) {
        candidate = candidate.slice(0, fenceEnd).trim();
      }
    }
  }

  if (candidate.startsWith('{')) {
    return extractJsonObject(candidate);
  }

  if (candidate.startsWith('.')) {
    candidate = candidate.slice(1).trimStart();
  }

  const firstLine = candidate.split(/\r?\n/)[0].trim();
  if (!firstLine || !firstLine.startsWith('"')) {
    return { ok: false, reason: 'missing_loose_object_body' };
  }

  let body = firstLine;
  if (body.endsWith('}')) {
    body = body.slice(0, -1).trimEnd();
  }

  try {
    const params = JSON.parse(`{${body}}`);
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return { ok: false, reason: 'loose_params_not_object' };
    }
    return { ok: true, params };
  } catch (_) {
    return { ok: false, reason: 'invalid_loose_json' };
  }
}

function validateParsedToolCall(server, toolName, params) {
  const tool = server.tools.get(toolName);
  if (!tool) {
    return { ok: false, reason: 'unknown_tool' };
  }

  const normalized = JSON.parse(JSON.stringify(params || {}));
  if (tool.definition.inputSchema?.properties) {
    for (const [key, prop] of Object.entries(tool.definition.inputSchema.properties)) {
      if (normalized[key] === undefined && prop.default !== undefined) {
        normalized[key] = prop.default;
      }
    }
  }

  if (tool.definition.inputSchema) {
    try {
      server.validateInput(normalized, tool.definition.inputSchema);
    } catch (error) {
      return { ok: false, reason: `schema_validation_failed:${error.message}` };
    }
  }

  return { ok: true, params: normalized };
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function coerceXmlValue(rawValue, schema = {}) {
  const value = decodeXmlEntities(rawValue).trim();
  if (schema.type === 'string') return value;
  if (schema.type === 'boolean' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if ((schema.type === 'number' || schema.type === 'integer') && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return schema.type === 'integer' ? Math.trunc(parsed) : parsed;
  }
  if (schema.type === 'null' && /^null$/i.test(value)) return null;
  if (schema.type === 'array' || schema.type === 'object' || /^[\[{]/.test(value)) {
    try { return JSON.parse(value); } catch (_) { return value; }
  }
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^null$/i.test(value)) return null;
  return value;
}

function extractXmlToolEnvelopes(server, source) {
  const envelopes = [];
  const blockPattern = /<(tool_call|function_call)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let blockMatch;

  while ((blockMatch = blockPattern.exec(source)) !== null) {
    if (isInsideMarkdownFence(source, blockMatch.index)) continue;
    const body = String(blockMatch[2] || '').trim();
    if (!body || body.startsWith('{')) continue;
    const nameMatch = /<(?:tool_name|name)>\s*([\s\S]*?)\s*<\/(?:tool_name|name)>/i.exec(body);
    const toolName = decodeXmlEntities(nameMatch?.[1] || '').trim();
    if (!toolName) continue;

    const argumentsMatch = /<(?:arguments|parameters|params|input)>\s*([\s\S]*?)\s*<\/(?:arguments|parameters|params|input)>/i.exec(body);
    let params = null;
    if (argumentsMatch) {
      const rawArguments = decodeXmlEntities(argumentsMatch[1]).trim();
      try { params = JSON.parse(rawArguments); } catch (_) { params = null; }
    }

    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      params = {};
      const properties = server.tools.get(toolName)?.definition?.inputSchema?.properties || {};
      const childPattern = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
      let childMatch;
      while ((childMatch = childPattern.exec(body)) !== null) {
        const key = childMatch[1];
        if (['tool_name', 'name', 'arguments', 'parameters', 'params', 'input'].includes(key)) continue;
        const parsedValue = coerceXmlValue(childMatch[2], properties[key] || {});
        if (params[key] === undefined) params[key] = parsedValue;
        else if (Array.isArray(params[key])) params[key].push(parsedValue);
        else params[key] = [params[key], parsedValue];
      }
    }

    envelopes.push({ toolName, params, toolCallId: '', snippet: blockMatch[0] });
  }
  return envelopes;
}

function isInsideMarkdownFence(source, index) {
  const prefix = source.slice(0, index);
  const fences = prefix.match(/^\s*```/gm) || [];
  return fences.length % 2 === 1;
}

function findBalancedJsonObjectEnd(source, start) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

function extractJsonToolEnvelopes(source) {
  const envelopes = [];
  const lineObjectPattern = /(^|\r?\n)[ \t]*(\{)/g;
  let match;

  while ((match = lineObjectPattern.exec(source)) !== null) {
    const objectStart = match.index + match[0].lastIndexOf('{');
    if (isInsideMarkdownFence(source, objectStart)) continue;

    const objectEnd = findBalancedJsonObjectEnd(source, objectStart);
    if (objectEnd === -1) continue;

    // Only accept an object occupying its own line. This prevents JSON examples
    // embedded in ordinary prose from becoming executable tool calls.
    const lineEnd = source.indexOf('\n', objectEnd);
    const trailing = source.slice(objectEnd, lineEnd === -1 ? source.length : lineEnd);
    if (trailing.trim()) continue;

    const parsed = extractJsonObject(source.slice(objectStart, objectEnd));
    if (!parsed.ok) continue;

    const rootEnvelope = parsed.params;
    const candidates = Array.isArray(rootEnvelope.tool_calls)
      ? rootEnvelope.tool_calls
      : [rootEnvelope];
    for (const envelope of candidates) {
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue;
      const functionEnvelope = envelope.function && typeof envelope.function === 'object'
        ? envelope.function
        : null;
      const toolName = [
        envelope.tool,
        envelope.tool_name,
        envelope.name,
        functionEnvelope?.name
      ].find(value => typeof value === 'string' && value.trim());
      if (!toolName) continue;

      const nestedParams = [
        functionEnvelope?.arguments,
        envelope.params,
        envelope.parameters,
        envelope.arguments,
        envelope.input
      ].find(value => value !== undefined);
      let params;
      if (nestedParams !== undefined) {
        params = nestedParams;
        if (typeof params === 'string') {
          try {
            params = JSON.parse(params);
          } catch (_) {
            params = null;
          }
        }
      } else {
        params = { ...envelope };
        delete params.tool;
        delete params.tool_name;
        delete params.name;
        delete params.function;
        delete params.type;
        delete params.tool_call_id;
        if (/^call_/i.test(String(params.id || ''))) delete params.id;
      }

      envelopes.push({
        toolName: String(toolName).trim(),
        params,
        toolCallId: String(envelope.tool_call_id || envelope.id || '').trim(),
        start: objectStart,
        end: objectEnd,
        snippet: source.slice(objectStart, Math.min(source.length, objectEnd))
      });
    }
    lineObjectPattern.lastIndex = objectEnd;
  }

  return envelopes;
}

function parseToolCall(server, text) {
  const source = String(text || '');
  const calls = [];
  const invalidCandidates = [];
  const acceptedKeys = new Set();
  // Some multilingual models emit Cyrillic homoglyphs in the reserved prefix
  // (for example ТО: where both letters are Cyrillic). Keep tool/schema names
  // strict, but accept Latin/Cyrillic-confusable TO and TOOL envelopes.
  const toolPrefix = /[TТ][OО](?:[OО][LЛ])?\s*:\s*([A-Za-z0-9_]+)/gi;
  let match;

  while ((match = toolPrefix.exec(source)) !== null) {
    const previousChar = match.index > 0 ? source[match.index - 1] : '';
    const isBoundary = !previousChar || /\s|[`"'([{<]/.test(previousChar);
    if (!isBoundary) {
      continue;
    }

    const toolName = match[1];
    const afterTool = source.slice(match.index + match[0].length);
    const parsed = extractJsonObject(afterTool);
    if (!parsed.ok) {
      invalidCandidates.push({
        toolName,
        reason: parsed.reason,
        snippet: source.slice(match.index, Math.min(source.length, match.index + 220))
      });
      continue;
    }

    const validated = validateParsedToolCall(server, toolName, parsed.params);
    if (!validated.ok) {
      invalidCandidates.push({
        toolName,
        reason: validated.reason,
        snippet: source.slice(match.index, Math.min(source.length, match.index + 220))
      });
      continue;
    }

    const acceptedKey = `${toolName}:${JSON.stringify(validated.params)}`;
    if (acceptedKeys.has(acceptedKey)) {
      continue;
    }
    acceptedKeys.add(acceptedKey);
    calls.push({
      toolName,
      params: validated.params,
      toolCallId: createToolCallId(),
      timestamp: new Date().toISOString()
    });
  }

  // Some models emit a generic JSON tool envelope instead of LocalAgent's
  // textual TOOL: protocol. Tool envelopes inside reasoning are intentional and
  // executable, matching the existing TOOL: and <invoke> behavior. Outside
  // reasoning, require the response to consist entirely of envelope objects so
  // an unfenced JSON example in ordinary prose does not become a tool call.
  const reasoningEnvelopeSources = [];
  const reasoningPattern = /<think>([\s\S]*?)<\/think>/gi;
  let reasoningMatch;
  while ((reasoningMatch = reasoningPattern.exec(source)) !== null) {
    reasoningEnvelopeSources.push(reasoningMatch[1] || '');
  }
  const reasoningJsonEnvelopes = reasoningEnvelopeSources
    .flatMap(reasoningSource => extractJsonToolEnvelopes(reasoningSource));
  const jsonEnvelopeSource = source
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
  const jsonEnvelopes = extractJsonToolEnvelopes(jsonEnvelopeSource);
  let envelopeRemainder = '';
  let envelopeCursor = 0;
  for (const envelope of jsonEnvelopes) {
    envelopeRemainder += jsonEnvelopeSource.slice(envelopeCursor, envelope.start);
    envelopeCursor = envelope.end;
  }
  envelopeRemainder += jsonEnvelopeSource.slice(envelopeCursor);
  const outsideJsonEnvelopes = envelopeRemainder.trim() ? [] : jsonEnvelopes;
  const executableJsonEnvelopes = [...reasoningJsonEnvelopes, ...outsideJsonEnvelopes];

  // Qwen/Minimax-style tagged calls and Anthropic-style invoke blocks are also
  // accepted directly, so every MCP execution entry point shares one parser.
  const taggedJsonEnvelopes = [];
  const taggedJsonPattern = /<(?:tool_call|function_call)>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call)>/gi;
  let taggedJsonMatch;
  while ((taggedJsonMatch = taggedJsonPattern.exec(source)) !== null) {
    const taggedBody = String(taggedJsonMatch[1] || '').trim();
    taggedJsonEnvelopes.push(...extractJsonToolEnvelopes(`\n${taggedBody}\n`));
  }

  const invokeEnvelopes = [];
  const invokePattern = /<invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  let invokeMatch;
  while ((invokeMatch = invokePattern.exec(source)) !== null) {
    const params = {};
    const paramPattern = /<parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let paramMatch;
    while ((paramMatch = paramPattern.exec(invokeMatch[2] || '')) !== null) {
      const key = String(paramMatch[1] || '').trim();
      if (!key) continue;
      const rawValue = String(paramMatch[2] || '')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .trim();
      try {
        params[key] = JSON.parse(rawValue);
      } catch (_) {
        params[key] = rawValue;
      }
    }
    invokeEnvelopes.push({
      toolName: String(invokeMatch[1] || '').trim(),
      params,
      toolCallId: '',
      snippet: invokeMatch[0]
    });
  }

  const xmlEnvelopes = extractXmlToolEnvelopes(server, source);
  for (const envelope of [...executableJsonEnvelopes, ...taggedJsonEnvelopes, ...xmlEnvelopes, ...invokeEnvelopes]) {
    if (!envelope.params || typeof envelope.params !== 'object' || Array.isArray(envelope.params)) {
      invalidCandidates.push({
        toolName: envelope.toolName,
        reason: 'params_not_object',
        snippet: envelope.snippet
      });
      continue;
    }

    const validated = validateParsedToolCall(server, envelope.toolName, envelope.params);
    if (!validated.ok) {
      invalidCandidates.push({
        toolName: envelope.toolName,
        reason: validated.reason,
        snippet: envelope.snippet
      });
      continue;
    }

    const acceptedKey = `${envelope.toolName}:${JSON.stringify(validated.params)}`;
    if (acceptedKeys.has(acceptedKey)) continue;
    acceptedKeys.add(acceptedKey);
    calls.push({
      toolName: envelope.toolName,
      params: validated.params,
      toolCallId: envelope.toolCallId || createToolCallId(),
      timestamp: new Date().toISOString()
    });
  }

  for (const [toolName] of server.tools) {
    const escapedTool = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const loosePattern = new RegExp(`\\b${escapedTool}\\b`, 'gi');
    let looseMatch;

    while ((looseMatch = loosePattern.exec(source)) !== null) {
      const before = looseMatch.index > 0 ? source[looseMatch.index - 1] : '';
      const afterStart = looseMatch.index + looseMatch[0].length;
      const after = source.slice(afterStart);

      if (before === ':') {
        continue;
      }

      const startsLikeParams = /^\s*(\{|\.)/.test(after);
      if (!startsLikeParams) {
        continue;
      }

      const parsed = extractLooseKeyValueObject(after);
      if (!parsed.ok) {
        invalidCandidates.push({
          toolName,
          reason: parsed.reason,
          snippet: source.slice(looseMatch.index, Math.min(source.length, looseMatch.index + 220))
        });
        continue;
      }

      const validated = validateParsedToolCall(server, toolName, parsed.params);
      if (!validated.ok) {
        invalidCandidates.push({
          toolName,
          reason: validated.reason,
          snippet: source.slice(looseMatch.index, Math.min(source.length, looseMatch.index + 220))
        });
        continue;
      }

      const acceptedKey = `${toolName}:${JSON.stringify(validated.params)}`;
      if (acceptedKeys.has(acceptedKey)) {
        continue;
      }
      acceptedKeys.add(acceptedKey);
      calls.push({
        toolName,
        params: validated.params,
        toolCallId: createToolCallId(),
        timestamp: new Date().toISOString()
      });
    }
  }

  server._lastInvalidToolCandidates = invalidCandidates;
  if (invalidCandidates.length > 0) {
    console.warn(`[MCP] Ignored ${invalidCandidates.length} malformed/non-executable tool candidate(s)`);
  }

  return calls;
}

module.exports = {
  parseToolCall
};
