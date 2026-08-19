// @ts-nocheck
function consumeLines(stream, onLine) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => {
      buffer += String(chunk || '');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line) onLine(line);
        newline = buffer.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) onLine(buffer.replace(/\r$/, ''));
      resolve();
    });
    stream.on('error', reject);
  });
}

async function consumeNdjson(stream, onPayload) {
  await consumeLines(stream, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try { onPayload(JSON.parse(trimmed)); } catch (_error) { /* ignore non-JSON logs */ }
  });
}

async function consumeSse(stream, onPayload) {
  await consumeLines(stream, (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try { onPayload(JSON.parse(data)); } catch (_error) { /* ignore keepalives */ }
  });
}

function safeJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch (_error) { return { partialArguments: value }; }
}

function createOpenAIAccumulator(turnEvents = null) {
  const state = { content: '', reasoning: '', model: '', usage: null, toolCalls: new Map() };
  const emit = (event) => turnEvents?.emit?.(event);
  return {
    state,
    push(payload = {}) {
      state.model = payload.model || state.model;
      if (payload.usage) {
        state.usage = payload.usage;
        emit({ type: 'usage.updated', usage: payload.usage });
      }
      const choice = payload.choices?.[0] || {};
      const delta = choice.delta || {};
      const content = typeof delta.content === 'string'
        ? delta.content
        : (Array.isArray(delta.content) ? delta.content.map(part => part?.text || '').join('') : '');
      const reasoning = String(delta.reasoning_content || delta.reasoning || delta.thinking || '');
      if (content) {
        state.content += content;
        emit({ type: 'content.delta', text: content });
      }
      if (reasoning) {
        state.reasoning += reasoning;
        emit({ type: 'reasoning.delta', text: reasoning });
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const key = call.index ?? call.id ?? state.toolCalls.size;
        const previous = state.toolCalls.get(key) || { id: call.id || null, type: 'function', function: { name: '', arguments: '' } };
        previous.id = call.id || previous.id;
        previous.function.name += call.function?.name || '';
        previous.function.arguments += call.function?.arguments || '';
        state.toolCalls.set(key, previous);
        emit({
          type: previous._announced ? 'action.updated' : 'action.started',
          action: {
            id: previous.id || `tool-${key}`,
            kind: 'tool',
            name: previous.function.name || 'tool',
            params: safeJson(previous.function.arguments),
            status: 'running'
          }
        });
        previous._announced = true;
      }
    },
    result() {
      return {
        content: state.content,
        reasoning: state.reasoning,
        model: state.model,
        usage: state.usage,
        toolCalls: [...state.toolCalls.values()].map(({ _announced, ...call }) => call)
      };
    }
  };
}

module.exports = { consumeNdjson, consumeSse, createOpenAIAccumulator };
