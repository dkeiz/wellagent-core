// ---------------------------------------------------------------------------
// lib/inference/context.ts — Conversation context management
// ---------------------------------------------------------------------------

import type { Message, Logger } from '../core/types';

const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * Rough token estimate for text.
 * Uses max of char/4 and word*1.35 heuristics.
 */
export function estimateTokens(text: string): number {
  const value = String(text || '');
  if (!value) return 0;
  const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0;
  const charEstimate = Math.ceil(value.length / 4);
  const wordEstimate = Math.ceil(wordCount * 1.35);
  return Math.max(charEstimate, wordEstimate);
}

/**
 * Estimate tokens for a message (content + role overhead).
 */
export function estimateMessageTokens(message: Message): number {
  if (!message) return 0;
  return estimateTokens(message.content) + 6;
}

/** Result of building conversation context. */
export interface ContextResult {
  messages: Message[];
  estimatedTokens: number;
  contextWindow: number;
  totalMessages: number;
  overflow: boolean;
}

/** Usage estimation result. */
export interface UsageEstimate {
  tokens: number;
  contextWindow: number;
  totalMessages: number;
  overflow: boolean;
}

/** Cleaners for normalizing messages. */
export interface MessageCleaners {
  stripToolPatterns?: (text: string) => string;
  stripReasoningBlocks?: (text: string) => string;
}

/**
 * Normalize a raw message into a clean { role, content } shape.
 */
export function normalizeMessage(
  row: any,
  cleaners: MessageCleaners = {}
): Message | null {
  const role = row?.role || 'user';
  let content = String(row?.content || '');

  if (role === 'assistant') {
    if (cleaners.stripToolPatterns) content = cleaners.stripToolPatterns(content);
    if (cleaners.stripReasoningBlocks) content = cleaners.stripReasoningBlocks(content);
  }

  content = content.trim();
  return content ? { role, content } : null;
}

/**
 * Normalize an array of messages.
 */
export function normalizeMessages(
  rows: any[],
  cleaners: MessageCleaners = {}
): Message[] {
  return Array.isArray(rows)
    ? rows.map(row => normalizeMessage(row, cleaners)).filter(Boolean) as Message[]
    : [];
}

/**
 * Build conversation context from message history.
 */
export function buildContext(
  rows: any[],
  options: { contextWindow?: number; cleaners?: MessageCleaners } = {}
): ContextResult {
  const messages = normalizeMessages(rows, options.cleaners);
  const contextWindow = Math.max(1, Number(options.contextWindow) || DEFAULT_CONTEXT_WINDOW);
  const estimatedTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  return {
    messages: messages.map(m => ({ ...m })),
    estimatedTokens,
    contextWindow,
    totalMessages: messages.length,
    overflow: estimatedTokens > contextWindow,
  };
}

/**
 * Estimate token usage for messages + an optional current prompt.
 */
export function estimateUsage(
  rows: any[],
  options: { contextWindow?: number; currentPrompt?: string; cleaners?: MessageCleaners } = {}
): UsageEstimate {
  const messages = normalizeMessages(rows, options.cleaners);
  const contextWindow = Math.max(1, Number(options.contextWindow) || DEFAULT_CONTEXT_WINDOW);

  const prompt = normalizeMessage(
    { role: 'user', content: options.currentPrompt || '' },
    options.cleaners
  );
  const fullMessages = prompt ? [...messages, prompt] : messages;
  const tokens = fullMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  return {
    tokens,
    contextWindow,
    totalMessages: fullMessages.length,
    overflow: tokens > contextWindow,
  };
}

/**
 * Session conversation context cache.
 * Keeps normalized message arrays in memory per session.
 */
export class ConversationContextCache {
  private _sessions: Map<string, { messages: Message[]; loaded: boolean }>;
  private _cleaners: MessageCleaners;

  constructor(options: { cleaners?: MessageCleaners } = {}) {
    this._sessions = new Map();
    this._cleaners = options.cleaners || {};
  }

  /**
   * Get cached messages for a session, or load them if not cached.
   */
  async getOrLoad(
    sessionId: string,
    loadFn: () => Promise<any[]>
  ): Promise<Message[]> {
    const key = String(sessionId || 'default');
    const cached = this._sessions.get(key);
    if (cached?.loaded) {
      return cached.messages.map(m => ({ ...m }));
    }

    const rows = await loadFn();
    const messages = normalizeMessages(rows, this._cleaners);
    this._sessions.set(key, { messages, loaded: true });
    return messages.map(m => ({ ...m }));
  }

  /**
   * Append a message to the cached session context.
   */
  append(sessionId: string, message: Message): void {
    const normalized = normalizeMessage(message, this._cleaners);
    if (!normalized) return;

    const key = String(sessionId || 'default');
    let cached = this._sessions.get(key);
    if (!cached) {
      cached = { messages: [], loaded: false };
      this._sessions.set(key, cached);
    }
    cached.messages.push(normalized);
  }

  /**
   * Invalidate a session cache (or all sessions if null).
   */
  invalidate(sessionId?: string | null): void {
    if (sessionId === null || sessionId === undefined) {
      this._sessions.clear();
    } else {
      this._sessions.delete(String(sessionId));
    }
  }
}
