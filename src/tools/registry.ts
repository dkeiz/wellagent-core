// ---------------------------------------------------------------------------
// lib/tools/registry.ts — Tool registration, validation, and policy enforcement
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolExecutionResult,
  Logger,
} from '../core/types';
import type { ToolPolicy } from './permissions';

export class ToolRegistry extends EventEmitter {
  private _tools: Map<string, ToolDefinition>;
  private _logger: Logger;
  private _policy: ToolPolicy | null;

  constructor(options: { logger?: Logger; policy?: ToolPolicy | null } = {}) {
    super();
    this._tools = new Map();
    this._logger = options.logger ?? console;
    this._policy = options.policy ?? null;
  }

  setPolicy(policy: ToolPolicy | null): void {
    this._policy = policy;
  }

  register(tool: ToolDefinition): void {
    const name = String(tool?.name || '').trim();
    if (!name) throw new Error('Tools require a non-empty name');
    this._tools.set(name, { ...tool, name });
    this.emit('tool:registered', { name });
  }

  registerBatch(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): boolean {
    const removed = this._tools.delete(name);
    if (removed) this.emit('tool:unregistered', { name });
    return removed;
  }

  get(name: string): ToolDefinition | null {
    return this._tools.get(name) ?? null;
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  list(filter?: { group?: string; safe?: boolean; includeHidden?: boolean }): ToolDefinition[] {
    let tools = Array.from(this._tools.values());
    if (filter?.group) tools = tools.filter(tool => tool.group === filter.group);
    if (filter?.safe !== undefined) tools = tools.filter(tool => tool.safe === filter.safe);
    if (!filter?.includeHidden) tools = tools.filter(tool => !tool.hidden);
    return tools.filter(tool => !tool.disabled).map(tool => ({ ...tool }));
  }

  names(): string[] {
    return Array.from(this._tools.keys());
  }

  get size(): number {
    return this._tools.size;
  }

  async execute(
    name: string,
    params: Record<string, any> = {},
    context: ToolExecutionContext = {}
  ): Promise<ToolExecutionResult> {
    const tool = this._tools.get(name);
    const started = Date.now();
    if (!tool) return failed(name, started, 'Unknown tool: ' + name);
    if (tool.disabled) return failed(name, started, 'Tool "' + name + '" is disabled');

    const validation = this.validateParams(name, params);
    if (!validation.valid) {
      return failed(name, started, validation.errors.join('; '));
    }

    if (this._policy) {
      const decision = await this._policy.checkTool(tool, params, context);
      if (!decision.allowed) {
        const result = failed(name, started, decision.reason || 'Tool policy denied execution');
        this.emit('tool:denied', { ...result, context });
        return result;
      }
    }

    this.emit('tool:executing', { name, params, context });
    try {
      const result: ToolResult = await tool.handler(params, context);
      const executionResult: ToolExecutionResult = {
        toolName: name,
        result,
        durationMs: Date.now() - started,
        permitted: true,
      };
      this.emit('tool:executed', executionResult);
      return executionResult;
    } catch (error: any) {
      const executionResult: ToolExecutionResult = {
        toolName: name,
        result: { error: error?.message || String(error), isError: true },
        durationMs: Date.now() - started,
        permitted: true,
        error: error?.message || String(error),
      };
      this.emit('tool:error', executionResult);
      return executionResult;
    }
  }

  getToolDescriptions(): string {
    return this.list()
      .map(tool => {
        const parameters = tool.parameters?.properties
          ? ' Parameters: ' + JSON.stringify(tool.parameters.properties)
          : '';
        return 'TOOL: ' + tool.name + ' - ' + tool.description + parameters;
      })
      .join('\n');
  }

  validateParams(name: string, params: Record<string, any>): { valid: boolean; errors: string[] } {
    const tool = this._tools.get(name);
    if (!tool) return { valid: false, errors: ['Unknown tool: ' + name] };

    const errors: string[] = [];
    const schema = tool.parameters;
    if (schema?.required) {
      for (const field of schema.required) {
        if (params[field] === undefined || params[field] === null) {
          errors.push('Missing required parameter: ' + field);
        }
      }
    }

    if (schema?.properties) {
      for (const [key, property] of Object.entries(schema.properties)) {
        const value = params[key];
        if (value === undefined || value === null || !property.type) continue;
        const actual = Array.isArray(value) ? 'array' : typeof value;
        if (property.type !== actual) {
          errors.push('Parameter "' + key + '" should be ' + property.type + ', got ' + actual);
        }
        if (property.enum && !property.enum.includes(String(value))) {
          errors.push('Parameter "' + key + '" must be one of: ' + property.enum.join(', '));
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }
}

function failed(toolName: string, started: number, error: string): ToolExecutionResult {
  return {
    toolName,
    result: { error, isError: true },
    durationMs: Date.now() - started,
    permitted: false,
    error,
  };
}
