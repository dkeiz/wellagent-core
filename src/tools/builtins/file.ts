// ---------------------------------------------------------------------------
// lib/tools/builtins/file.ts — File system tools
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../core/types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * File system tools — read, write, list directories.
 */
export function createFileTools(options: { workspaceRoot?: string } = {}): ToolDefinition[] {
  const root = options.workspaceRoot || process.cwd();

  return [
    {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read' },
          encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
        },
        required: ['path'],
      },
      group: 'file',
      safe: true,
      handler: async (params) => {
        try {
          const filePath = path.resolve(root, params.path);
          const content = fs.readFileSync(filePath, (params.encoding || 'utf-8') as BufferEncoding);
          return { content: String(content) };
        } catch (error: any) {
          return { error: error.message, isError: true };
        }
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
      group: 'file',
      safe: false,
      requiresConfirmation: true,
      handler: async (params) => {
        try {
          const filePath = path.resolve(root, params.path);
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, params.content, 'utf-8');
          return { content: `File written: ${filePath}` };
        } catch (error: any) {
          return { error: error.message, isError: true };
        }
      },
    },
    {
      name: 'list_dir',
      description: 'List contents of a directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
        },
        required: ['path'],
      },
      group: 'file',
      safe: true,
      handler: async (params) => {
        try {
          const dirPath = path.resolve(root, params.path);
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const items = entries.map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
            size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : undefined,
          }));
          return { content: JSON.stringify(items, null, 2) };
        } catch (error: any) {
          return { error: error.message, isError: true };
        }
      },
    },
  ];
}
