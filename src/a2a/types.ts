// ---------------------------------------------------------------------------
// lib/a2a/types.ts — A2A protocol types
// ---------------------------------------------------------------------------

export type A2ATaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'input-required';

export interface A2ATarget {
  id: string;
  name: string;
  description?: string;
  url?: string;
  capabilities?: A2ACapability[];
  authToken?: string;
  discoveredAt?: string;
  lastSeenAt?: string;
  status?: 'online' | 'offline' | 'unknown';
}

export interface A2ACapability {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
}

export interface A2ATask {
  id: string;
  targetId: string;
  status: A2ATaskStatus;
  input?: any;
  output?: any;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  sessionId?: string;
  userId?: string;
}

export interface A2AMessage {
  taskId: string;
  role: 'user' | 'agent';
  content: string;
  timestamp?: string;
  parts?: A2AMessagePart[];
}

export interface A2AMessagePart {
  type: 'text' | 'file' | 'data';
  text?: string;
  fileName?: string;
  mimeType?: string;
  data?: any;
}

export interface A2AAgentCard {
  name: string;
  description?: string;
  version?: string;
  capabilities?: A2ACapability[];
  url?: string;
  authentication?: {
    type: 'none' | 'bearer' | 'api-key';
    required: boolean;
  };
}

export interface A2AStreamEvent {
  type: 'status' | 'artifact' | 'message' | 'error';
  taskId: string;
  status?: A2ATaskStatus;
  content?: string;
  artifact?: any;
  error?: string;
}
