// ---------------------------------------------------------------------------
// lib/agents/memory.ts — Memory service backed by an optional storage port
// ---------------------------------------------------------------------------

import type { MemoryEntry, Logger } from '../core/types';
import type { MemoryStore } from '../storage/ports';
import type { VectorStore } from '../storage/vector-store';

export class AgentMemory {
  private _store: MemoryStore;
  private _vectorStore: VectorStore | null;
  private _entries: Map<string, MemoryEntry>;
  private _logger: Logger;

  constructor(options: {
    store?: MemoryStore;
    vectorStore?: VectorStore;
    logger?: Logger;
  } = {}) {
    this._store = options.store ?? {};
    this._vectorStore = options.vectorStore ?? null;
    this._entries = new Map();
    this._logger = options.logger ?? console;
  }

  async save(entry: MemoryEntry): Promise<string> {
    const id = entry.id || 'mem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const stored: MemoryEntry = {
      ...entry,
      id,
      timestamp: entry.timestamp || new Date().toISOString(),
    };

    this._entries.set(id, stored);
    await this._store.saveMemory?.({ ...stored });

    if (this._vectorStore) {
      try {
        await this._vectorStore.add(id, stored.content, {
          type: stored.type,
          timestamp: stored.timestamp,
        });
      } catch (error: any) {
        this._logger.warn?.('[AgentMemory] Failed to index entry ' + id + ':', error?.message);
      }
    }

    return id;
  }

  async recall(query: string, options: { topK?: number } = {}): Promise<MemoryEntry[]> {
    const topK = options.topK ?? 5;

    if (this._vectorStore) {
      const results = await this._vectorStore.search(query, topK);
      return results
        .map(result => this._entries.get(result.id))
        .filter(Boolean) as MemoryEntry[];
    }

    const queryLower = query.toLowerCase();
    return Array.from(this._entries.values())
      .filter(entry => entry.content.toLowerCase().includes(queryLower))
      .slice(0, topK)
      .map(entry => ({ ...entry }));
  }

  getAll(): MemoryEntry[] {
    return Array.from(this._entries.values()).map(entry => ({ ...entry }));
  }

  get(id: string): MemoryEntry | null {
    const entry = this._entries.get(id);
    return entry ? { ...entry } : null;
  }

  async delete(id: string): Promise<boolean> {
    const existed = this._entries.delete(id);
    if (!existed) return false;

    const removed = await this._store.deleteMemory?.(id);
    if (removed === false) {
      this._logger.warn?.('[AgentMemory] Storage did not remove entry ' + id);
    }
    this._vectorStore?.remove(id);
    return true;
  }

  async load(): Promise<number> {
    if (!this._store.loadMemory) return 0;
    const entries = await this._store.loadMemory();
    for (const entry of entries) {
      if (!entry.id) continue;
      this._entries.set(entry.id, { ...entry });
    }
    this._logger.log?.('[AgentMemory] Loaded ' + entries.length + ' entries');
    return entries.length;
  }

  /** Backward-compatible alias. Memory stores are not assumed to be file based. */
  async loadFromDisk(): Promise<number> {
    return this.load();
  }

  get size(): number {
    return this._entries.size;
  }
}
