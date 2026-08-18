// ---------------------------------------------------------------------------
// lib/ui/message-formatter.ts — Message rendering pipeline
// ---------------------------------------------------------------------------

/**
 * Markdown-to-HTML message formatter.
 *
 * Provides platform-agnostic formatting for LLM responses:
 * - Code blocks with language tags
 * - Inline code
 * - Bold, italic, links
 * - Tool call blocks
 * - Thinking blocks
 * - HTML escaping
 *
 * Usage:
 * ```typescript
 * const html = formatMessage('Here is some **bold** and `code`');
 * const htmlWithTools = formatMessage('TOOL: get_time {}', { renderToolCalls: true });
 * ```
 */

/** Format options. */
export interface FormatOptions {
  renderToolCalls?: boolean;
  renderThinking?: boolean;
  maxCodeBlockLength?: number;
  linkTarget?: '_blank' | '_self';
  escapeHtml?: boolean;
}

/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format a message string into HTML.
 */
export function formatMessage(content: string, options: FormatOptions = {}): string {
  let text = String(content || '');

  // Extract and preserve code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langLabel = lang ? ` data-language="${escapeHtml(lang)}"` : '';
    const trimmed = options.maxCodeBlockLength && code.length > options.maxCodeBlockLength
      ? code.slice(0, options.maxCodeBlockLength) + '\n... [truncated]'
      : code;
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(
      `<pre class="code-block"${langLabel}><code>${escapeHtml(trimmed)}</code></pre>`
    );
    return placeholder;
  });

  // Thinking blocks
  if (options.renderThinking !== false) {
    text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, thought) => {
      return `<details class="thinking-block"><summary>Thinking...</summary><div class="thinking-content">${escapeHtml(thought.trim())}</div></details>`;
    });
  }

  // Tool call blocks
  if (options.renderToolCalls) {
    text = text.replace(/TOOL\s*:\s*(\w+)\s*(\{[\s\S]*?\})/g, (_match, name, params) => {
      return `<div class="tool-call-block" data-tool="${escapeHtml(name)}"><span class="tool-name">${escapeHtml(name)}</span><pre class="tool-params">${escapeHtml(params)}</pre></div>`;
    });
  }

  // Escape remaining HTML (unless disabled)
  if (options.escapeHtml !== false) {
    // Only escape text outside of our preserved blocks
    text = text.replace(/__CODE_BLOCK_\d+__/g, (match) => match); // keep placeholders
    const parts = text.split(/(__CODE_BLOCK_\d+__)/);
    text = parts.map(part => {
      if (/^__CODE_BLOCK_\d+__$/.test(part)) return part;
      return escapeHtml(part);
    }).join('');
  }

  // Inline markdown → HTML
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Links
  const target = options.linkTarget || '_blank';
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    `<a href="$2" target="${target}" rel="noopener">$1</a>`
  );

  // Standalone URLs
  text = text.replace(
    /(?<!["=])(https?:\/\/[^\s<>"]+)/g,
    `<a href="$1" target="${target}" rel="noopener">$1</a>`
  );

  // Line breaks → paragraphs
  text = text.replace(/\n\n+/g, '</p><p>');
  text = text.replace(/\n/g, '<br>');
  text = `<p>${text}</p>`;

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
  }

  return text;
}

/**
 * Strip all formatting from a message, returning plain text.
 */
export function stripFormatting(content: string): string {
  let text = String(content || '');
  text = text.replace(/```\w*\n[\s\S]*?```/g, '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/TOOL\s*:\s*\w+\s*\{[\s\S]*?\}/g, '');
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return text.trim();
}

/**
 * Detect content type from a message.
 */
export function detectContentType(content: string): 'text' | 'code' | 'tool-call' | 'thinking' | 'mixed' {
  const text = String(content || '');
  const hasCode = /```/.test(text);
  const hasToolCall = /TOOL\s*:\s*\w+/.test(text);
  const hasThinking = /<think>/i.test(text);
  const types = [hasCode, hasToolCall, hasThinking].filter(Boolean).length;
  if (types > 1) return 'mixed';
  if (hasCode) return 'code';
  if (hasToolCall) return 'tool-call';
  if (hasThinking) return 'thinking';
  return 'text';
}
