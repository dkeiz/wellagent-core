// --- Agent types ---

export type AgentType = 'pro' | 'sub' | 'superagent' | string;

export interface Agent {
  id: number;
  name: string;
  type: AgentType;
  systemPrompt?: string;
  modelOverride?: string | null;
  providerOverride?: string | null;
  active?: boolean;
  directory?: string | null;
  plugins?: string[];
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
  ownerId?: string;
}

export interface AgentConfig {
  name: string;
  type: AgentType;
  systemPrompt?: string;
  modelOverride?: string | null;
  providerOverride?: string | null;
  plugins?: string[];
  active?: boolean;
  directory?: string;
}

export interface SubagentRun {
  id: number;
  parentSessionId: string;
  parentMessageId?: number | null;
  agentId?: number | null;
  agentName?: string;
  childSessionId: string;
  status: SubagentRunStatus;
  resultPayload?: any;
  artifacts?: any[];
  startedAt?: string;
  completedAt?: string | null;
  runtimePolicyProfile?: string;
  runtimePolicyGrants?: Record<string, any>;
  userId?: string;
  ownerId?: string;
  attempts?: number;
}

export type SubagentRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentResult {
  success: boolean;
  content?: string;
  artifacts?: any[];
  error?: string;
  runId?: number;
  sessionId?: string;
}

export interface AgentScope {
  userId: string;
  ownerId?: string;
}

export interface AgentDelegationOptions {
  parentSessionId: string;
  parentMessageId?: number;
  agentId?: number;
  agentName?: string;
  task: string;
  modelOverride?: string;
  providerOverride?: string;
  maxTurns?: number;
  timeoutMs?: number;
  runtimePolicyProfile?: string;
  runtimePolicyGrants?: Record<string, any>;
  plugins?: string[];
  requestContext?: any;
}
