// ---------------------------------------------------------------------------
// lib/tools/builtins/terminal.ts — Terminal/command execution tools
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../core/types';
import { execSync, exec } from 'child_process';

/**
 * Terminal tools — execute shell commands.
 */
export function createTerminalTools(options: {
  workspaceRoot?: string;
  timeout?: number;
  maxOutputLength?: number;
} = {}): ToolDefinition[] {
  const root = options.workspaceRoot || process.cwd();
  const timeout = options.timeout ?? 30000;
  const maxOutput = options.maxOutputLength ?? 50000;

  return [
    {
      name: 'run_command',
      description: 'Execute a shell command and return the output',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
          timeout: { type: 'number', description: 'Timeout in milliseconds' },
        },
        required: ['command'],
      },
      group: 'terminal',
      safe: false,
      requiresConfirmation: true,
      handler: async (params) => {
        try {
          const output = execSync(params.command, {
            cwd: params.cwd || root,
            timeout: params.timeout || timeout,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
          });
          const trimmed = String(output).length > maxOutput
            ? String(output).slice(0, maxOutput) + '\n... [truncated]'
            : String(output);
          return { content: trimmed };
        } catch (error: any) {
          const output = error.stdout ? String(error.stdout) : '';
          const stderr = error.stderr ? String(error.stderr) : '';
          return {
            error: `Exit code ${error.status || 1}: ${stderr || error.message}`,
            content: output,
            isError: true,
          };
        }
      },
    },
  ];
}
