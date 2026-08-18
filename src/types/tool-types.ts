// --- Tool / MCP types ---

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: ToolParameterSchema;
  group?: string;
  category?: string;
  requiresConfirmation?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  source?: 'builtin' | 'plugin' | 'custom' | 'proxy' | string;
  pluginId?: string;
  handler?: ToolHandler;
}

export interface ToolParameterSchema {
  type: 'object';
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: any;
  items?: ToolParameterProperty;
}

export type ToolHandler = (args: Record<string, any>, context?: ToolExecutionContext) => Promise<ToolResult> | ToolResult;

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, any> | string;
}

export interface ToolResult {
  content?: string;
  result?: any;
  error?: string;
  isError?: boolean;
  metadata?: Record<string, any>;
}

export interface ToolGroup {
  id: string;
  name: string;
  description?: string;
  tools: string[];
  enabled?: boolean;
}

export interface ToolPermission {
  toolName: string;
  allowed: boolean;
  reason?: string;
  grantedBy?: string;
  expiresAt?: string;
}

export interface ToolExecutionContext {
  sessionId?: string;
  agentId?: number | null;
  agentName?: string;
  runId?: string;
  userId?: string;
  requestContext?: any;
  runtimePolicy?: any;
  isSubagent?: boolean;
  delegationDepth?: number;
}

export interface ToolExecutionResult {
  toolName: string;
  result: ToolResult;
  durationMs?: number;
  permitted: boolean;
  error?: string;
}
