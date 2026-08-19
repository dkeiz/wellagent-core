// @ts-nocheck
function safeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

async function* readSseEvents(stream) {
  let buffer = '';
  let dataLines = [];
  const emit = () => {
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') return { done: true };
    try { return { value: JSON.parse(data) }; } catch (_) { return null; }
  };

  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') {
        const event = emit();
        if (event?.done) return;
        if (event?.value) yield event.value;
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
  const event = emit();
  if (event?.value) yield event.value;
}

function responseError(event) {
  const source = event?.response?.error || event?.error || event;
  const message = source?.message || source?.code || 'Codex response failed';
  const error = new Error(String(message));
  error.code = source?.code || 'CODEX_RESPONSE_ERROR';
  return error;
}

function incompleteResponseError(event, partTypes) {
  const response = event?.response || {};
  const details = response.incomplete_details || response.status_details || {};
  const reason = details.reason || details.message || response.status || 'unknown reason';
  const error = new Error(`Codex response incomplete: ${reason}`);
  error.code = 'CODEX_RESPONSE_INCOMPLETE';
  error.responseId = response.id || null;
  error.details = details;
  error.partTypes = Array.from(partTypes);
  return error;
}

async function consumeCodexResponsesStream(stream, turnEvents = null) {
  let content = '';
  let reasoning = '';
  let usage = {};
  let responding = false;
  const partTypes = new Set();
  const activeCalls = new Map();
  const toolCalls = [];
  let terminalState = null;
  let responseId = null;

  const ensureCall = item => {
    const key = String(item?.output_index ?? item?.item_id ?? item?.call_id ?? item?.id ?? activeCalls.size);
    if (!activeCalls.has(key)) {
      activeCalls.set(key, {
        toolCallId: String(item?.call_id || item?.item?.call_id || item?.id || item?.item?.id || ''),
        toolName: String(item?.name || item?.item?.name || ''),
        arguments: String(item?.arguments || item?.item?.arguments || '')
      });
    }
    return activeCalls.get(key);
  };

  const finishCall = (key, item = {}) => {
    const call = activeCalls.get(key) || ensureCall(item);
    if (item?.call_id) call.toolCallId = String(item.call_id);
    if (item?.name) call.toolName = String(item.name);
    if (item?.arguments !== undefined) call.arguments = String(item.arguments || '');
    if (!call.toolCallId || !call.toolName) return;
    if (toolCalls.some(existing => existing.toolCallId === call.toolCallId)) return;
    const input = safeJson(call.arguments, {});
    toolCalls.push({ toolCallId: call.toolCallId, toolName: call.toolName, input });
    turnEvents?.emit?.({
      type: 'action.updated',
      action: { id: call.toolCallId, kind: 'tool', name: call.toolName, params: input, status: 'queued' }
    });
  };

  for await (const event of readSseEvents(stream)) {
    const type = String(event?.type || 'unknown');
    partTypes.add(type);
    if (type === 'response.output_text.delta') {
      const text = String(event.delta || '');
      content += text;
      if (text && !responding) {
        responding = true;
        turnEvents?.emit?.({ type: 'status', phase: 'responding', message: 'Codex is responding' });
      }
      if (text) turnEvents?.emit?.({ type: 'content.delta', text });
    } else if (type === 'response.reasoning_summary_text.delta') {
      const text = String(event.delta || '');
      reasoning += text;
      if (text) turnEvents?.emit?.({ type: 'reasoning.delta', text });
    } else if (type === 'response.output_item.added' && event?.item?.type === 'function_call') {
      const call = ensureCall(event);
      turnEvents?.emit?.({
        type: 'action.started',
        action: { id: call.toolCallId, kind: 'tool', name: call.toolName || 'tool', params: {}, status: 'running' }
      });
    } else if (type === 'response.function_call_arguments.delta') {
      const call = ensureCall(event);
      call.arguments += String(event.delta || '');
    } else if (type === 'response.function_call_arguments.done') {
      const key = String(event?.output_index ?? event?.item_id ?? event?.call_id ?? '');
      finishCall(key, event);
    } else if (type === 'response.output_item.done' && event?.item?.type === 'function_call') {
      const key = String(event?.output_index ?? event?.item?.id ?? event?.item?.call_id ?? '');
      finishCall(key, event.item);
    } else if (type === 'response.completed') {
      usage = event?.response?.usage || usage;
      terminalState = 'completed';
      responseId = event?.response?.id || responseId;
      for (const [key] of activeCalls) finishCall(key);
    } else if (type === 'response.incomplete') {
      usage = event?.response?.usage || usage;
      for (const [key] of activeCalls) finishCall(key);
      throw incompleteResponseError(event, partTypes);
    } else if (type === 'response.failed' || type === 'error') {
      throw responseError(event);
    }
  }

  for (const [key] of activeCalls) finishCall(key);
  if (terminalState !== 'completed') {
    const error = new Error('Codex response stream ended without a terminal response.completed event');
    error.code = 'CODEX_STREAM_TRUNCATED';
    error.partTypes = Array.from(partTypes);
    throw error;
  }
  return { content, reasoning, usage, toolCalls, partTypes: Array.from(partTypes), terminalState, responseId };
}

module.exports = {
  consumeCodexResponsesStream,
  readSseEvents
};
