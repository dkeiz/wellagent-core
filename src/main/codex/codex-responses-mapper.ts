// @ts-nocheck
function textInput(role, text, type) {
  return {
    role,
    content: [{ type, text: String(text || '') }]
  };
}

function mapUserContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
  return parts.map(part => {
    if (part?.type === 'image') {
      const bytes = Buffer.isBuffer(part.image) ? part.image : Buffer.from(part.image || '');
      return {
        type: 'input_image',
        image_url: `data:${part.mediaType || 'image/png'};base64,${bytes.toString('base64')}`
      };
    }
    return { type: 'input_text', text: String(part?.text || '') };
  });
}

function toolOutputValue(output = {}) {
  if (output?.type === 'json') return JSON.stringify(output.value);
  if (output?.type === 'text') return String(output.value || '');
  return typeof output === 'string' ? output : JSON.stringify(output?.value ?? output ?? '');
}

function mapCodexInput(messages = [], system = '') {
  const input = [];
  if (system) input.push({ role: 'developer', content: String(system) });

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'user') {
      input.push({ role: 'user', content: mapUserContent(message.content) });
      continue;
    }
    if (message?.role === 'assistant') {
      const parts = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: String(message.content || '') }];
      const textParts = parts.filter(part => part?.type === 'text');
      if (textParts.length > 0) {
        input.push(textInput('assistant', textParts.map(part => part.text || '').join(''), 'output_text'));
      }
      for (const part of parts) {
        if (part?.type !== 'tool-call') continue;
        input.push({
          type: 'function_call',
          call_id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.input || {})
        });
      }
      continue;
    }
    if (message?.role === 'tool') {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== 'tool-result') continue;
        input.push({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: toolOutputValue(part.output)
        });
      }
    }
  }
  return input;
}

function mapCodexTools(definitions = []) {
  return (Array.isArray(definitions) ? definitions : []).map(definition => ({
    type: 'function',
    name: String(definition.name || ''),
    description: String(definition.description || definition.userDescription || ''),
    parameters: definition.inputSchema || {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })).filter(tool => tool.name);
}

function buildCodexResponseBody({ model, system, messages, tools: definitions, reasoningEffort }) {
  const tools = mapCodexTools(definitions);
  return {
    model,
    input: mapCodexInput(messages, system),
    ...(tools.length > 0 ? { tools } : {}),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: 'auto' } } : {}),
    include: ['reasoning.encrypted_content'],
    store: false,
    stream: true
  };
}

module.exports = {
  buildCodexResponseBody,
  mapCodexInput,
  mapCodexTools
};
