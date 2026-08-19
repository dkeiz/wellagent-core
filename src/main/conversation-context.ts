// @ts-nocheck
const DEFAULT_CONTEXT_WINDOW = 8192;

function estimateTextTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0;
  const charEstimate = Math.ceil(value.length / 4);
  const wordEstimate = Math.ceil(wordCount * 1.35);
  return Math.max(charEstimate, wordEstimate);
}

function estimateMessageTokens(message) {
  if (!message) return 0;
  return estimateTextTokens(message.content) + 6;
}

function parseContextWindow(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW;
}

function getConversationHistoryBudget(contextWindow, currentPrompt = '') {
  const windowSize = parseContextWindow(contextWindow);
  estimateTextTokens(currentPrompt);
  // NO TRUNCATION EVER in application chat-history assembly. Provider/model
  // context limits are reported as overflow, but this app must not cut saved
  // session messages before dispatch.
  return windowSize;
}

function normalizeConversationMessage(row, cleaners = {}) {
  const role = row?.role || 'user';
  let content = String(row?.content || '');
  if (role === 'assistant') {
    if (typeof cleaners.stripToolPatterns === 'function') {
      content = cleaners.stripToolPatterns(content);
    }
    if (typeof cleaners.stripReasoningBlocks === 'function') {
      content = cleaners.stripReasoningBlocks(content);
    }
  }
  content = content.trim();
  return content ? { role, content } : null;
}

function normalizeConversationMessages(rows, cleaners = {}) {
  return Array.isArray(rows)
    ? rows.map(row => normalizeConversationMessage(row, cleaners)).filter(Boolean)
    : [];
}

function buildConversationContext(rows, options = {}) {
  const allMessages = normalizeConversationMessages(rows, options.cleaners);
  const contextWindow = parseContextWindow(options.contextWindow);
  const estimatedTokens = allMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

  return {
    messages: allMessages.map(message => ({ ...message })),
    estimatedTokens,
    availableHistoryTokens: estimatedTokens,
    contextWindow,
    totalMessages: allMessages.length,
    includedMessages: allMessages.length,
    truncated: false
  };
}

function calculateConversationContextUsage(rows, options = {}) {
  const allMessages = normalizeConversationMessages(rows, options.cleaners);
  const contextWindow = parseContextWindow(options.contextWindow);
  const prompt = normalizeConversationMessage({ role: 'user', content: options.currentPrompt || '' }, options.cleaners);
  const fullMessages = prompt ? [...allMessages, prompt] : allMessages;
  const tokens = fullMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return {
    tokens,
    contextWindow,
    totalMessages: fullMessages.length,
    savedMessages: allMessages.length,
    overflow: tokens > contextWindow,
    truncatedForSend: false
  };
}

class SessionConversationContextCache {
  constructor(options = {}) {
    this.cleaners = options.cleaners || {};
    this.sessions = new Map();
  }

  _key(sessionId = null) {
    return String(sessionId || 'default');
  }

  async getOrLoad(sessionId, loadAllHistory) {
    const key = this._key(sessionId);
    const cached = this.sessions.get(key);
    if (cached?.loaded === true) {
      return cached.messages.map(message => ({ ...message }));
    }

    try {
      const rows = await loadAllHistory();
      const messages = normalizeConversationMessages(rows, this.cleaners);
      this.sessions.set(key, { messages, loaded: true });
      return messages.map(message => ({ ...message }));
    } catch (error) {
      const fallback = this.sessions.get(key);
      if (fallback) {
        return fallback.messages.map(message => ({ ...message }));
      }
      throw error;
    }
  }

  append(sessionId, message) {
    // This is the durable chat-side cache: every persisted turn is appended to
    // the in-process normalized session context. NO TRUNCATION EVER: inference
    // requests receive the full cached conversation; provider/model limits are
    // reported separately as overflow. If the process restarts or this cache is
    // invalidated, getOrLoad rebuilds it from the full saved chat before inference.
    const normalized = normalizeConversationMessage(message, this.cleaners);
    if (!normalized) return;
    const key = this._key(sessionId);
    let cached = this.sessions.get(key);
    if (!cached) {
      // Cold appends are partial until getOrLoad can rebuild from durable
      // storage. This preserves the new message without hiding older DB rows.
      cached = { messages: [], loaded: false };
      this.sessions.set(key, cached);
    }
    cached.messages.push(normalized);
  }

  invalidate(sessionId = null) {
    if (sessionId === null || sessionId === undefined) {
      this.sessions.clear();
      return;
    }
    this.sessions.delete(this._key(sessionId));
  }
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  estimateTextTokens,
  estimateMessageTokens,
  getConversationHistoryBudget,
  calculateConversationContextUsage,
  buildConversationContext,
  normalizeConversationMessage,
  normalizeConversationMessages,
  SessionConversationContextCache
};
