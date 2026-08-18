// ---------------------------------------------------------------------------
// lib/agents/agent-loop.ts — Autonomous agent loop (session lifecycle)
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import type { Dispatcher } from '../inference/dispatcher';
import type { AgentMemory } from './memory';
import type { ChatSessionStore } from '../storage/ports';
import type { Logger } from '../core/types';

/** Per-session state. */
interface SessionState {
  autoMemory: boolean;
  idleSeconds: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  memorySaved: boolean;
  memoryLoaded: boolean;
  lastActivity: number;
  userId?: string;
}

/**
 * Manages autonomous agent behaviors across sessions.
 *
 * Three triggers:
 * 1. **Session Start** — load memory context into session
 * 2. **Idle (AutoMemory)** — after idle_seconds of silence, create memory entry
 * 3. **Session Close** — summarize session on close/switch
 *
 * Usage:
 * ```typescript
 * const loop = new AgentLoop({ dispatcher, memory, db });
 * await loop.startSession('session-123', { userId: 'user-1' });
 * loop.onActivity('session-123'); // reset idle timer
 * await loop.endSession('session-123'); // triggers close summary
 * ```
 */
export class AgentLoop extends EventEmitter {
  private _dispatcher: Dispatcher;
  private _memory: AgentMemory;
  private _db: ChatSessionStore;
  private _sessions: Map<string, SessionState>;
  private _logger: Logger;
  private _defaultIdleSeconds: number;

  constructor(options: {
    dispatcher: Dispatcher;
    memory: AgentMemory;
    db: ChatSessionStore;
    defaultIdleSeconds?: number;
    logger?: Logger;
  }) {
    super();
    this._dispatcher = options.dispatcher;
    this._memory = options.memory;
    this._db = options.db;
    this._sessions = new Map();
    this._defaultIdleSeconds = options.defaultIdleSeconds ?? 60;
    this._logger = options.logger ?? console;
  }

  /**
   * Start tracking a session. Loads memory if available.
   */
  async startSession(sessionId: string, options: { userId?: string; autoMemory?: boolean } = {}): Promise<void> {
    const state: SessionState = {
      autoMemory: options.autoMemory ?? false,
      idleSeconds: this._defaultIdleSeconds,
      idleTimer: null,
      memorySaved: false,
      memoryLoaded: false,
      lastActivity: Date.now(),
      userId: options.userId,
    };
    this._sessions.set(sessionId, state);

    // Load memory context
    try {
      const memories = await this._memory.recall('session context', { topK: 10 });
      if (memories.length > 0) {
        state.memoryLoaded = true;
        this.emit('memory:loaded', { sessionId, count: memories.length });
      }
    } catch (error: any) {
      this._logger.warn?.(`[AgentLoop] Failed to load memory for session ${sessionId}:`, error?.message);
    }

    this.emit('session:started', { sessionId });
  }

  /**
   * Record activity on a session (resets idle timer).
   */
  onActivity(sessionId: string): void {
    const state = this._sessions.get(sessionId);
    if (!state) return;

    state.lastActivity = Date.now();

    // Reset idle timer
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    if (state.autoMemory) {
      state.idleTimer = setTimeout(() => {
        this._onIdle(sessionId).catch(() => {});
      }, state.idleSeconds * 1000);
    }
  }

  /**
   * Enable or disable auto-memory for a session.
   */
  setAutoMemory(sessionId: string, enabled: boolean, idleSeconds?: number): void {
    const state = this._sessions.get(sessionId);
    if (!state) return;

    state.autoMemory = enabled;
    if (idleSeconds !== undefined) state.idleSeconds = idleSeconds;

    // Clear existing timer
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    if (enabled) {
      this.onActivity(sessionId); // Start the timer
    }
  }

  /**
   * End a session. Triggers close summary if auto-memory is enabled.
   */
  async endSession(sessionId: string): Promise<void> {
    const state = this._sessions.get(sessionId);
    if (!state) return;

    // Clear idle timer
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    // Save session summary if auto-memory is on
    if (state.autoMemory && !state.memorySaved) {
      try {
        await this._saveSessionSummary(sessionId, state);
        state.memorySaved = true;
      } catch (error: any) {
        this._logger.warn?.(`[AgentLoop] Failed to save session summary for ${sessionId}:`, error?.message);
      }
    }

    this._sessions.delete(sessionId);
    this.emit('session:ended', { sessionId });
  }

  /**
   * Get session state.
   */
  getSession(sessionId: string): SessionState | null {
    return this._sessions.get(sessionId) ?? null;
  }

  /**
   * Get all active session IDs.
   */
  getActiveSessions(): string[] {
    return Array.from(this._sessions.keys());
  }

  private async _onIdle(sessionId: string): Promise<void> {
    const state = this._sessions.get(sessionId);
    if (!state || !state.autoMemory) return;

    this._logger.log?.(`[AgentLoop] Idle trigger for session ${sessionId}`);
    this.emit('session:idle', { sessionId });

    try {
      // Get recent messages to summarize
      const messages = await this._db.getMessages(sessionId, 20);
      if (messages.length === 0) return;

      const lastContent = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-5)
        .map(m => `${m.role}: ${String(m.content).slice(0, 200)}`)
        .join('\n');

      if (lastContent) {
        await this._memory.save({
          content: `[Auto-memory from session ${sessionId}]\n${lastContent}`,
          type: 'conversation',
          sessionId,
          source: 'auto-memory-idle',
        });
        this.emit('memory:saved', { sessionId, trigger: 'idle' });
      }
    } catch (error: any) {
      this._logger.warn?.(`[AgentLoop] Idle memory save failed for ${sessionId}:`, error?.message);
    }
  }

  private async _saveSessionSummary(sessionId: string, state: SessionState): Promise<void> {
    const messages = await this._db.getMessages(sessionId, 50);
    if (messages.length === 0) return;

    const summary = messages
      .filter(m => m.role === 'user')
      .map(m => String(m.content).slice(0, 100))
      .slice(0, 10)
      .join('\n- ');

    if (summary) {
      await this._memory.save({
        content: `[Session summary ${sessionId}]\nTopics discussed:\n- ${summary}`,
        type: 'conversation',
        sessionId,
        source: 'session-close',
      });
      this.emit('memory:saved', { sessionId, trigger: 'close' });
    }
  }
}
