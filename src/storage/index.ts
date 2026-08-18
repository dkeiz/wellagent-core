// ---------------------------------------------------------------------------
// lib/storage/index.ts — Storage layer barrel export
// ---------------------------------------------------------------------------

export type { DatabaseAdapter } from './database';
export { InMemoryDatabase } from './database';

export type {
  AgentStore, ChatSessionStore, IdentityStore, MemoryStore, ResourceId,
  RuntimeStorage, SecretStorePort, StorageLifecycle, StoredAgent, StoredWorkflow, WorkflowStore,
} from './ports';

export type { Migration } from './migrations';
export { MigrationRunner } from './migrations';

export type { EmbeddingProvider, VectorDocument, VectorSearchResult } from './vector-store';
export { VectorStore, cosineSimilarity } from './vector-store';
