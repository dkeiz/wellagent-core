// ---------------------------------------------------------------------------
// lib/tools/builtins/web.ts — Web search and fetch tools
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../core/types';

/**
 * Web tools — web search and URL fetching.
 */
export function createWebTools(): ToolDefinition[] {
  return [
    {
      name: 'web_search',
      description: 'Search the web for information. Returns a summary of results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: 'Maximum number of results (default: 5)' },
        },
        required: ['query'],
      },
      group: 'web',
      safe: true,
      handler: async (params) => {
        // This is a stub — concrete implementation depends on the search provider
        // (SearXNG, Brave, Google, etc.) configured by the developer.
        return {
          content: `[web_search] Search for "${params.query}" — no search provider configured. Install a search plugin or override this tool handler.`,
        };
      },
    },
    {
      name: 'fetch_url',
      description: 'Fetch the content of a URL and return it as text',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          maxLength: { type: 'number', description: 'Max content length to return' },
        },
        required: ['url'],
      },
      group: 'web',
      safe: true,
      handler: async (params) => {
        try {
          const response = await fetch(params.url, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': 'LocalAgent/1.0' },
          });
          if (!response.ok) {
            return { error: `HTTP ${response.status}: ${response.statusText}`, isError: true };
          }
          let text = await response.text();
          const maxLen = params.maxLength || 50000;
          if (text.length > maxLen) {
            text = text.slice(0, maxLen) + '\n... [truncated]';
          }
          return { content: text };
        } catch (error: any) {
          return { error: error.message, isError: true };
        }
      },
    },
  ];
}
