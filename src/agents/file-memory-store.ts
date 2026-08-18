// ---------------------------------------------------------------------------
// lib/agents/file-memory-store.ts — Optional file-backed memory adapter
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import type { MemoryEntry } from '../core/types';
import type { MemoryStore } from '../storage/ports';

/**
 * File-backed memory is an opt-in adapter. Construction never creates files;
 * the first save operation creates its target directory.
 */
export class FileMemoryStore implements MemoryStore {
  private _basePath: string;

  constructor(basePath: string) {
    this._basePath = path.resolve(basePath);
  }

  async loadMemory(): Promise<MemoryEntry[]> {
    if (!fs.existsSync(this._basePath)) return [];

    const entries: MemoryEntry[] = [];
    for (const fileName of fs.readdirSync(this._basePath)) {
      if (!fileName.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(this._basePath, fileName), 'utf-8');
      const entry = parseEntry(fileName, raw);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async saveMemory(entry: MemoryEntry): Promise<void> {
    if (!entry.id) throw new Error('FileMemoryStore requires a memory entry id');
    fs.mkdirSync(this._basePath, { recursive: true });
    const header = [
      '---',
      'id: ' + entry.id,
      'type: ' + (entry.type || 'fact'),
      'timestamp: ' + (entry.timestamp || new Date().toISOString()),
      entry.source ? 'source: ' + entry.source : null,
      entry.sessionId ? 'sessionId: ' + entry.sessionId : null,
      entry.agentId !== undefined ? 'agentId: ' + entry.agentId : null,
      '---',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(path.join(this._basePath, entry.id + '.md'), header + '\n\n' + entry.content + '\n', 'utf-8');
  }

  async deleteMemory(id: string): Promise<boolean> {
    const filePath = path.join(this._basePath, id + '.md');
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }
}

function parseEntry(fileName: string, raw: string): MemoryEntry | null {
  const id = fileName.replace(/\.md$/, '');
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  const contentStart = frontmatter ? frontmatter[0].length : 0;
  const content = raw.slice(contentStart).trim();
  if (!content) return null;

  const field = (name: string): string | undefined => {
    const match = frontmatter?.[1].match(new RegExp('^' + name + ':\\s*(.+)$', 'm'));
    return match?.[1]?.trim();
  };
  const agentId = field('agentId');
  return {
    id,
    content,
    type: field('type'),
    timestamp: field('timestamp'),
    source: field('source'),
    sessionId: field('sessionId'),
    agentId: agentId && /^\\d+$/.test(agentId) ? Number(agentId) : undefined,
  };
}
