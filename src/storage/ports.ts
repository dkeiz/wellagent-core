// ---------------------------------------------------------------------------
// lib/storage/ports.ts — Persistence contracts for runtime capabilities
// ---------------------------------------------------------------------------

import type {
  AgentDefinition,
  ChatMessage,
  MemoryEntry,
  ScopeOptions,
  SettingsStore,
  SessionRecord,
  WorkflowDefinition,
} from '../core/types';

export type ResourceId = string | number;

export interface StorageLifecycle {
  init?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface ChatSessionStore {
  saveMessage(message: ChatMessage): Promise<void> | void;
  getMessages(sessionId: string, limit?: number, options?: ScopeOptions): Promise<ChatMessage[]> | ChatMessage[];
  getConversations(limit?: number, sessionId?: string | null, options?: ScopeOptions): Promise<ChatMessage[]> | ChatMessage[];
  createSession(options?: { id?: string; title?: string; userId?: string; agentId?: ResourceId | null }): Promise<string> | string;
  loadChatSession?(sessionId: string, options?: ScopeOptions): Promise<ChatMessage[]> | ChatMessage[];
  listSessions?(options?: ScopeOptions): Promise<SessionRecord[]> | SessionRecord[];
  deleteSession?(sessionId: string, options?: ScopeOptions): Promise<void> | void;
}

export type StoredAgent = Omit<AgentDefinition, 'id'> & {
  id: ResourceId;
  createdAt?: string;
  updatedAt?: string;
};

export interface AgentStore {
  listAgents?(options?: ScopeOptions): Promise<StoredAgent[]> | StoredAgent[];
  saveAgent?(agent: StoredAgent, options?: ScopeOptions): Promise<StoredAgent> | StoredAgent;
  deleteAgent?(agentId: ResourceId, options?: ScopeOptions): Promise<boolean> | boolean;
}

export type StoredWorkflow = Omit<WorkflowDefinition, 'id'> & {
  id: ResourceId;
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
};

export interface WorkflowStore {
  listWorkflows?(options?: ScopeOptions): Promise<StoredWorkflow[]> | StoredWorkflow[];
  saveWorkflow?(workflow: StoredWorkflow, options?: ScopeOptions): Promise<StoredWorkflow> | StoredWorkflow;
  deleteWorkflow?(workflowId: ResourceId, options?: ScopeOptions): Promise<boolean> | boolean;
}

export interface MemoryStore {
  loadMemory?(options?: ScopeOptions): Promise<MemoryEntry[]> | MemoryEntry[];
  saveMemory?(entry: MemoryEntry, options?: ScopeOptions): Promise<void> | void;
  deleteMemory?(id: string, options?: ScopeOptions): Promise<boolean> | boolean;
}

export interface SecretStorePort {
  getSecret(key: string, options?: ScopeOptions): Promise<string | null> | string | null;
  setSecret(key: string, value: string, options?: ScopeOptions): Promise<void> | void;
  deleteSecret?(key: string, options?: ScopeOptions): Promise<void> | void;
}

export interface IdentityStore<TIdentity = unknown> {
  getIdentity?(id: string): Promise<TIdentity | null> | TIdentity | null;
  listIdentities?(): Promise<TIdentity[]> | TIdentity[];
}

export interface RuntimeStorage extends SettingsStore, ChatSessionStore, StorageLifecycle, AgentStore, WorkflowStore, MemoryStore {}
