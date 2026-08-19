// @ts-nocheck
function stripToolPatterns(text) {
  if (!text) return '';
  let result = '';
  let i = 0;

  while (i < text.length) {
    const toolMatch = text.slice(i).match(/^[TТ][OО](?:[OО][LЛ])?\s*:\s*[A-Za-z0-9_]+\s*\{/i);
    if (toolMatch) {
      const braceStart = i + toolMatch[0].length - 1;
      let depth = 1;
      let j = braceStart + 1;
      let inString = false;
      let escapeNext = false;

      while (j < text.length && depth > 0) {
        const char = text[j];
        if (escapeNext) {
          escapeNext = false;
          j++;
          continue;
        }
        if (char === '\\') {
          escapeNext = true;
          j++;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          j++;
          continue;
        }
        if (!inString) {
          if (char === '{') depth++;
          else if (char === '}') depth--;
        }
        j++;
      }
      if (depth > 0) {
        // Malformed TOOL payload without closing brace; preserve text.
        result += text[i];
        i++;
        continue;
      }
      i = j;
    } else {
      result += text[i];
      i++;
    }
  }

  return result
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi, '')
    .replace(/<invoke\s+name\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<\/invoke>/gi, '')
    .trim();
}

function stripReasoningBlocks(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function buildAssistantContent(response, runtimeConfig = {}) {
  const reasoning = String(response?.reasoning || '').trim();
  const content = String(response?.content || '').trim();
  const visibility = runtimeConfig?.reasoning?.visibility || 'show';
  const provider = String(response?.renderContext?.provider || '').toLowerCase();
  const tps = Number(response?.tokens_per_second);
  const tpsSuffix = (provider === 'lmstudio' && Number.isFinite(tps) && tps > 0)
    ? `\n\n[t/s: ${tps.toFixed(1)}]`
    : '';

  if (!reasoning || visibility === 'hide') {
    return `${content}${tpsSuffix}`.trim();
  }

  return `<think>${reasoning}</think>\n\n${content}${tpsSuffix}`.trim();
}

module.exports = {
  stripToolPatterns,
  stripReasoningBlocks,
  buildAssistantContent
};
