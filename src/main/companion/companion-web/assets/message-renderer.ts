// @ts-nocheck
(function bootstrapCompanionMessageRenderer(global) {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function sanitizeUrl(url, options = {}) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (options.allowDataImage && /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) return value;
    try {
      const parsed = new URL(value, global.location.origin);
      const protocol = parsed.protocol.toLowerCase();
      const allowed = ['http:', 'https:', 'mailto:'];
      if (!allowed.includes(protocol)) return '';
      return parsed.toString();
    } catch (_) {
      return '';
    }
  }

  function isLikelyImageUrl(url) {
    return /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(String(url || '').trim());
  }

  function renderPlainText(text) {
    return escapeHtml(String(text || '')).replace(/\n/g, '<br>');
  }

  function renderBlocks(text) {
    const lines = String(text || '').split('\n');
    const blocks = [];
    let paragraph = [];
    let listItems = [];
    let listTag = '';
    let quoteLines = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!listTag || !listItems.length) return;
      blocks.push(`<${listTag}>${listItems.join('')}</${listTag}>`);
      listItems = [];
      listTag = '';
    };
    const flushQuote = () => {
      if (!quoteLines.length) return;
      blocks.push(`<blockquote>${quoteLines.join('<br>')}</blockquote>`);
      quoteLines = [];
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
      flushQuote();
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();
      if (!trimmed) {
        flushAll();
        continue;
      }
      if (/^@@FMT\d+@@$/.test(trimmed)) {
        flushAll();
        blocks.push(trimmed);
        continue;
      }
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        flushAll();
        blocks.push(`<h${headingMatch[1].length}>${headingMatch[2]}</h${headingMatch[1].length}>`);
        continue;
      }
      const quoteMatch = trimmed.match(/^&gt;\s?(.*)$/);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        quoteLines.push(quoteMatch[1]);
        continue;
      }
      const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
      if (unorderedMatch) {
        flushParagraph();
        flushQuote();
        if (listTag && listTag !== 'ul') flushList();
        listTag = 'ul';
        listItems.push(`<li>${unorderedMatch[1]}</li>`);
        continue;
      }
      const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
      if (orderedMatch) {
        flushParagraph();
        flushQuote();
        if (listTag && listTag !== 'ol') flushList();
        listTag = 'ol';
        listItems.push(`<li>${orderedMatch[1]}</li>`);
        continue;
      }
      flushList();
      flushQuote();
      paragraph.push(trimmed);
    }

    flushAll();
    return blocks.join('');
  }

  function renderAttachmentMarker(kind, fileName, options = {}) {
    const artifactUrlFor = typeof options.artifactUrlFor === 'function' ? options.artifactUrlFor : null;
    const url = artifactUrlFor ? artifactUrlFor(fileName) : '';
    const safeName = escapeHtml(fileName);
    if (!url) return `<span class="companion-attachment companion-attachment-file">${safeName}</span>`;
    const safeUrl = escapeAttribute(url);
    if (kind === 'image') {
      return `<a class="companion-attachment companion-attachment-image" href="${safeUrl}" target="_blank" rel="noreferrer">`
        + `<img class="chat-image" src="${safeUrl}" alt="${escapeAttribute(fileName)}">`
        + `<span>${safeName}</span></a>`;
    }
    if (kind === 'audio') {
      return `<div class="companion-attachment companion-attachment-audio"><span>${safeName}</span><audio controls src="${safeUrl}"></audio></div>`;
    }
    return `<a class="companion-attachment companion-attachment-file" href="${safeUrl}" target="_blank" rel="noreferrer">${safeName}</a>`;
  }

  function renderMarkdown(text, options = {}) {
    const placeholders = [];
    const stash = (html) => {
      const token = `@@FMT${placeholders.length}@@`;
      placeholders.push({ token, html });
      return token;
    };

    let content = String(text || '');
    const allowImages = options.allowImages === true;

    content = content.replace(/^\[(Image attached|Voice message|File attached):\s*([^\]]+)\]/gim, (match, label, fileName) => {
      const normalized = label === 'Image attached' ? 'image' : label === 'Voice message' ? 'audio' : 'file';
      return stash(renderAttachmentMarker(normalized, fileName.trim(), options));
    });

    content = content.replace(/```([\w-]+)?\n([\s\S]*?)```/g, (match, lang, code) => stash(
      `<pre><code class="language-${escapeAttribute(lang || 'text')}">${escapeHtml(code.trim())}</code></pre>`
    ));

    if (allowImages) {
      content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        const safeUrl = sanitizeUrl(url, { allowDataImage: true });
        if (!safeUrl) return escapeHtml(match);
        return stash(`<img src="${escapeAttribute(safeUrl)}" alt="${escapeAttribute(alt || '')}" class="chat-image">`);
      });
    }

    content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
      const safeUrl = sanitizeUrl(url);
      if (!safeUrl) return escapeHtml(label);
      return stash(`<a href="${escapeAttribute(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    });

    if (allowImages) {
      content = content.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"')]+)(?=[$\s),.!?;:])/gim, (match, prefix, url) => {
        if (!isLikelyImageUrl(url)) return match;
        const safeUrl = sanitizeUrl(url, { allowDataImage: true });
        if (!safeUrl) return match;
        return `${prefix}${stash(`<img src="${escapeAttribute(safeUrl)}" alt="Image" class="chat-image">`)}`;
      });
    }

    content = content.replace(/`([^`]+)`/g, (match, code) => stash(`<code>${escapeHtml(code)}</code>`));
    content = escapeHtml(content);
    content = content.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    content = content.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    content = renderBlocks(content);
    placeholders.forEach(({ token, html }) => {
      content = content.split(token).join(html);
    });
    return content;
  }

  function renderAssistantContent(text, thinkingVisibility, options = {}) {
    const content = String(text || '');
    const fragments = [];
    const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    let match;
    let lastIndex = 0;

    while ((match = thinkRegex.exec(content)) !== null) {
      const before = content.slice(lastIndex, match.index).trim();
      if (before) fragments.push(renderMarkdown(before, { ...options, allowImages: true }));
      if (thinkingVisibility !== 'hide') {
        const openAttr = thinkingVisibility === 'show' ? ' open' : '';
        fragments.push(
          `<details class="thinking-block"${openAttr}>`
          + `<summary>Thinking</summary>`
          + `<div class="thinking-content">${renderPlainText(match[1].trim())}</div>`
          + `</details>`
        );
      }
      lastIndex = match.index + match[0].length;
    }

    const remaining = content.slice(lastIndex).trim();
    if (remaining) fragments.push(renderMarkdown(remaining, { ...options, allowImages: true }));
    return fragments.length ? fragments.join('') : renderMarkdown(content, { ...options, allowImages: true });
  }

  function renderMessage(role, content, options = {}) {
    if (role === 'assistant') {
      return renderAssistantContent(content, options.thinkingVisibility || 'show', options);
    }
    return renderMarkdown(content, { ...options, allowImages: role !== 'system' });
  }

  global.LocalAgentCompanionMessageRenderer = { renderMessage };
})(window);
