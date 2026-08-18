// ---------------------------------------------------------------------------
// lib/storage/database.ts — Database abstraction layer
// ---------------------------------------------------------------------------

import type { ScopeOptions, SettingsStore, ChatMessage, SessionRecord, Logger } from '../core/types';
import type { ResourceId, RuntimeStorage, StoredAgent, StoredWorkflow } from './ports';

/**
 * Full database adapter interface.
 * Extends SettingsStore with chat, session, credential, and raw query operations.
 *
 * Implementations can back this with SQLite, Postgres, or even in-memory stores.
 */
export interface DatabaseAdapter extends RuntimeStorage {
  // Lifecycle
  init(): Promise<void>;
  close(): void;

  // Chat messages
  saveMessage(message: ChatMessage): Promise<void>;
  getMessages(sessionId: string, limit?: number, options?: any): Promise<ChatMessage[]>;
  getConversations(limit?: number, sessionId?: string | null, options?: any): Promise<ChatMessage[]>;

  // Sessions
  createSession(options?: any): Promise<string>;
  loadChatSession?(sessionId: string, options?: any): Promise<ChatMessage[]>;
  listSessions?(options?: any): Promise<SessionRecord[]>;
  deleteSession?(sessionId: string): Promise<void>;

  // Credentials
  setAPIKey?(provider: string, key: string, scope?: ScopeOptions): Promise<void>;
  getAPIKey?(provider: string, scope?: ScopeOptions): Promise<string | null>;
  getCredential?(key: string, scope?: any): Promise<string | null>;

  // Raw query (for extensions)
  run?(sql: string, params?: any[]): any;
  get?(sql: string, params?: any[]): any;
  all?(sql: string, params?: any[]): any[];

  // Synchronous setting access (for bootstrap)
  getSettingSync?(key: string): string | null;
  setSetting?(key: string, value: string): void;

  // Workflow embeddings (optional)
  updateWorkflowEmbedding?(workflowId: number | string, embedding: number[], options?: any): Promise<void>;
  getWorkflows?(options?: any): Promise<any[]>;
}

/**
 * In-memory database implementation.
 * Useful for testing, ephemeral sessions, and environments without SQLite.
 */
export class InMemoryDatabase implements DatabaseAdapter {
  private _settings: Map<string, string>;
  private _scopedSettings: Map<string, string>;
  private _messages: Map<string, ChatMessage[]>;
  private _sessions: Map<string, SessionRecord>;
  private _apiKeys: Map<string, string>;
  private _credentials: Map<string, string>;
  private _agents: Map<ResourceId, StoredAgent>;
  private _workflows: Map<ResourceId, StoredWorkflow>;
  private _memory: Map<string, import('../core/types').MemoryEntry>;
  private _logger: Logger;

  constructor(options: { logger?: Logger } = {}) {
    this._settings = new Map();
    this._scopedSettings = new Map();
    this._messages = new Map();
    this._sessions = new Map();
    this._apiKeys = new Map();
    this._credentials = new Map();
    this._agents = new Map();
    this._workflows = new Map();
    this._memory = new Map();
    this._logger = options.logger ?? console;
  }

  async init(): Promise<void> {
    this._logger.log?.('[InMemoryDatabase] Initialized');
  }

  close(): void {
    this._settings.clear();
    this._scopedSettings.clear();
    this._messages.clear();
    this._sessions.clear();
    this._apiKeys.clear();
    this._credentials.clear();
    this._agents.clear();
    this._workflows.clear();
    this._memory.clear();
  }

  // --- Settings ---

  private _scopeKey(key: string, scope: ScopeOptions): string {
    const userId = scope.userId || '_global';
    return `${userId}::${key}`;
  }

  getSetting(key: string): string | null {
    return this._settings.get(key) ?? null;
  }

  getSettingSync(key: string): string | null {
    return this._settings.get(key) ?? null;
  }

  saveSetting(key: string, value: string): void {
    this._settings.set(key, value);
  }

  setSetting(key: string, value: string): void {
    this._settings.set(key, value);
  }

  deleteSetting(key: string): void {
    this._settings.delete(key);
  }

  getScopedSetting(key: string, scope: ScopeOptions): string | null {
    return this._scopedSettings.get(this._scopeKey(key, scope))
      ?? this._settings.get(key)
      ?? null;
  }

  saveScopedSetting(key: string, value: string, scope: ScopeOptions): void {
    this._scopedSettings.set(this._scopeKey(key, scope), value);
  }

  deleteScopedSetting(key: string, scope: ScopeOptions): void {
    this._scopedSettings.delete(this._scopeKey(key, scope));
  }

  // --- Chat Messages ---

  async saveMessage(message: ChatMessage): Promise<void> {
    const sid = message.sessionId || 'default';
    if (!this._messages.has(sid)) {
      this._messages.set(sid, []);
    }
    const messages = this._messages.get(sid)!;
    const stored: ChatMessage = {
      ...message,
      id: message.id ?? messages.length + 1,
      sessionId: sid,
      timestamp: message.timestamp ?? new Date().toISOString(),
    };
    messages.push(stored);
  }

  async getMessages(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    const messages = this._messages.get(sessionId) || [];
    return limit ? messages.slice(-limit) : [...messages];
  }

  async getConversations(limit?: number, sessionId?: string | null): Promise<ChatMessage[]> {
    if (sessionId) {
      return this.getMessages(sessionId, limit);
    }
    const all: ChatMessage[] = [];
    for (const msgs of this._messages.values()) {
      all.push(...msgs);
    }
    return limit ? all.slice(-limit) : all;
  }

  // --- Sessions ---

  async createSession(options: any = {}): Promise<string> {
    const id = options.id || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: SessionRecord = {
      id,
      title: options.title || 'New Session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: options.userId,
      agentId: options.agentId ?? null,
      messageCount: 0,
    };
    this._sessions.set(id, session);
    return id;
  }

  async loadChatSession(sessionId: string): Promise<ChatMessage[]> {
    return this.getMessages(sessionId);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return Array.from(this._sessions.values());
  }

  async deleteSession(sessionId: string): Promise<void> {
    this._sessions.delete(sessionId);
    this._messages.delete(sessionId);
  }

  // --- Credentials ---

  async setAPIKey(provider: string, key: string): Promise<void> {
    this._apiKeys.set(provider, key);
  }

  async getAPIKey(provider: string): Promise<string | null> {
    return this._apiKeys.get(provider) ?? null;
  }

  async getCredential(key: string): Promise<string | null> {
    return this._credentials.get(key) ?? this._settings.get(key) ?? null;
  }

  async listAgents(): Promise<StoredAgent[]> {
    return Array.from(this._agents.values()).map(agent => ({ ...agent }));
  }

  async saveAgent(agent: StoredAgent): Promise<StoredAgent> {
    const stored = { ...agent };
    this._agents.set(stored.id, stored);
    return { ...stored };
  }

  async deleteAgent(agentId: ResourceId): Promise<boolean> {
    return this._agents.delete(agentId);
  }

  async listWorkflows(): Promise<StoredWorkflow[]> {
    return Array.from(this._workflows.values()).map(workflow => ({ ...workflow }));
  }

  async saveWorkflow(workflow: StoredWorkflow): Promise<StoredWorkflow> {
    const stored = { ...workflow };
    this._workflows.set(stored.id, stored);
    return { ...stored };
  }

  async deleteWorkflow(workflowId: ResourceId): Promise<boolean> {
    return this._workflows.delete(workflowId);
  }

  async loadMemory(): Promise<import('../core/types').MemoryEntry[]> {
    return Array.from(this._memory.values()).map(entry => ({ ...entry }));
  }

  async saveMemory(entry: import('../core/types').MemoryEntry): Promise<void> {
    if (entry.id) this._memory.set(entry.id, { ...entry });
  }

  async deleteMemory(id: string): Promise<boolean> {
    return this._memory.delete(id);
  }
}
