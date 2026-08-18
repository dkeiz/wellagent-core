// --- Workflow types ---

export type WorkflowTriggerType = 'manual' | 'schedule' | 'event' | 'webhook' | string;

export type WorkflowStepType = 'llm' | 'tool' | 'condition' | 'loop' | 'parallel' | 'webhook' | string;

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Workflow {
  id: number;
  name: string;
  description?: string;
  triggerType?: WorkflowTriggerType;
  triggerConfig?: Record<string, any> | null;
  steps: WorkflowStep[];
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
  ownerId?: string;
}

export interface WorkflowStep {
  id?: string;
  name?: string;
  type: WorkflowStepType;
  config: Record<string, any>;
  onSuccess?: string;
  onFailure?: string;
  timeout?: number;
}

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  schedule?: string;
  eventType?: string;
  webhookPath?: string;
  config?: Record<string, any>;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  status: WorkflowRunStatus;
  startedAt?: string;
  completedAt?: string | null;
  result?: any;
  error?: string | null;
  stepResults?: Record<string, any>;
}

export interface WorkflowScope {
  userId: string;
  ownerId?: string;
}

export interface WorkflowExecutionContext {
  workflowId: number;
  runId?: number;
  sessionId?: string;
  userId?: string;
  requestContext?: any;
  variables?: Record<string, any>;
}
