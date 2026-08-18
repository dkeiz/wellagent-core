// ---------------------------------------------------------------------------
// lib/agents/index.ts — Agents layer barrel export
// ---------------------------------------------------------------------------

export { AgentManager } from './manager';
export type { Agent } from './manager';

export { AgentMemory } from './memory';
export { FileMemoryStore } from './file-memory-store';

export { AgentLoop } from './agent-loop';

export { SubagentRuntime } from './subagent';
export type { SubagentConfig, SubagentResult } from './subagent';

export { AgentRoom } from './room';
export type { RoomParticipant, RoomRoundResult } from './room';
