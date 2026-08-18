// ---------------------------------------------------------------------------
// lib/tools/builtins/core.ts — Safe tools backed by explicit core services
// ---------------------------------------------------------------------------

import type { MemoryEntry, ToolDefinition } from '../../core/types';

export interface CoreToolServices {
  memory?: {
    save(entry: MemoryEntry): Promise<string>;
    recall(query: string, options?: { topK?: number }): Promise<MemoryEntry[]>;
  };
}

export function createCoreTools(services: CoreToolServices = {}): ToolDefinition[] {
  return [
    {
      name: 'get_time',
      description: 'Get the current date and time',
      group: 'core',
      safe: true,
      handler: async () => ({ content: new Date().toISOString() }),
    },
    {
      name: 'think',
      description: 'Record a concise internal working note for this run',
      parameters: {
        type: 'object',
        properties: {
          thought: { type: 'string', description: 'A concise internal note' },
        },
        required: ['thought'],
      },
      group: 'core',
      safe: true,
      handler: async (params) => ({
        content: '[Thought recorded: ' + String(params.thought || '').slice(0, 100) + '...]',
      }),
    },
    {
      name: 'memory_save',
      description: 'Save information to configured long-term memory',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The information to remember' },
          type: { type: 'string', description: 'Memory type', enum: ['fact', 'preference', 'conversation'] },
        },
        required: ['content'],
      },
      group: 'core',
      safe: true,
      handler: async (params, context) => {
        if (!services.memory) {
          return { error: 'Memory service is not configured', isError: true };
        }
        const id = await services.memory.save({
          content: params.content,
          type: params.type || 'fact',
          sessionId: context.sessionId || undefined,
          agentId: context.agentId ?? undefined,
          source: 'tool:memory_save',
        });
        return { content: 'Memory saved: ' + id, metadata: { id } };
      },
    },
    {
      name: 'memory_recall',
      description: 'Search configured long-term memory',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          limit: { type: 'number', description: 'Maximum results' },
        },
        required: ['query'],
      },
      group: 'core',
      safe: true,
      handler: async (params) => {
        if (!services.memory) {
          return { error: 'Memory service is not configured', isError: true };
        }
        const entries = await services.memory.recall(params.query, { topK: params.limit || 5 });
        return { content: JSON.stringify(entries) };
      },
    },
  ];
}
