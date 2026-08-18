// ---------------------------------------------------------------------------
// lib/a2a/index.ts — A2A protocol barrel export
// ---------------------------------------------------------------------------

export type {
  A2ATaskStatus, A2ATarget, A2ACapability, A2ATask,
  A2AMessage, A2AMessagePart, A2AAgentCard, A2AStreamEvent,
} from './types';

export { A2AManager } from './manager';
export { A2AClient } from './client';
export { A2AServer } from './server';
