// ---------------------------------------------------------------------------
// lib/storage/vector-store.ts — Vector similarity search
// ---------------------------------------------------------------------------

import type { Logger } from '../core/types';

/**
 * Interface for embedding providers (Ollama, OpenAI, etc.).
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
  isAvailable?(): Promise<boolean>;
}

/** A stored vector document. */
export interface VectorDocument {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, any>;
}

/** A search result with score. */
export interface VectorSearchResult {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, any>;
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * In-memory vector store with cosine similarity search.
 *
 * For production, this can be backed by a SQLite table with serialized
 * embeddings, or replaced with a dedicated vector database.
 *
 * Usage:
 * ```typescript
 * const store = new VectorStore(embeddingProvider);
 * await store.add('doc-1', 'The quick brown fox');
 * await store.add('doc-2', 'A lazy dog sleeps');
 * const results = await store.search('fast fox', 5);
 * ```
 */
export class VectorStore {
  private _embedder: EmbeddingProvider;
  private _documents: Map<string, VectorDocument>;
  private _logger: Logger;

  constructor(embedder: EmbeddingProvider, options: { logger?: Logger } = {}) {
    this._embedder = embedder;
    this._documents = new Map();
    this._logger = options.logger ?? console;
  }

  /**
   * Add a document to the store. Generates and caches its embedding.
   */
  async add(id: string, text: string, metadata?: Record<string, any>): Promise<void> {
    try {
      const embedding = await this._embedder.embed(text);
      this._documents.set(id, { id, text, embedding, metadata });
    } catch (error: any) {
      this._logger.error?.(`[VectorStore] Failed to index "${id}":`, error?.message);
      throw error;
    }
  }

  /**
   * Add a document with a pre-computed embedding.
   */
  addWithEmbedding(id: string, text: string, embedding: number[], metadata?: Record<string, any>): void {
    this._documents.set(id, { id, text, embedding, metadata });
  }

  /**
   * Search for similar documents.
   */
  async search(query: string, topK: number = 5): Promise<VectorSearchResult[]> {
    try {
      const queryEmbedding = await this._embedder.embed(query);
      return this.searchByVector(queryEmbedding, topK);
    } catch (error: any) {
      this._logger.error?.('[VectorStore] Search failed:', error?.message);
      return [];
    }
  }

  /**
   * Search by pre-computed vector.
   */
  searchByVector(queryEmbedding: number[], topK: number = 5): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];

    for (const doc of this._documents.values()) {
      const score = cosineSimilarity(queryEmbedding, doc.embedding);
      results.push({
        id: doc.id,
        text: doc.text,
        score,
        metadata: doc.metadata,
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Remove a document by ID.
   */
  remove(id: string): boolean {
    return this._documents.delete(id);
  }

  /**
   * Check if a document exists.
   */
  has(id: string): boolean {
    return this._documents.has(id);
  }

  /**
   * Get a document by ID.
   */
  get(id: string): VectorDocument | null {
    return this._documents.get(id) ?? null;
  }

  /**
   * Total number of indexed documents.
   */
  get size(): number {
    return this._documents.size;
  }

  /**
   * Clear all documents.
   */
  clear(): void {
    this._documents.clear();
  }

  /**
   * Re-index all documents (re-generate embeddings).
   */
  async reindex(): Promise<{ indexed: number; failed: number }> {
    let indexed = 0;
    let failed = 0;

    for (const doc of this._documents.values()) {
      try {
        doc.embedding = await this._embedder.embed(doc.text);
        indexed++;
      } catch (error: any) {
        this._logger.error?.(`[VectorStore] Failed to reindex "${doc.id}":`, error?.message);
        failed++;
      }
    }

    return { indexed, failed };
  }
}
