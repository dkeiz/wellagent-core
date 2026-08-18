// ---------------------------------------------------------------------------
// lib/agents/room.ts — Multi-agent room (collaborative context)
// ---------------------------------------------------------------------------

import type { Dispatcher } from '../inference/dispatcher';
import type { AgentManager, Agent } from './manager';
import type { Message, Logger } from '../core/types';
import type { ResourceId } from '../storage/ports';

/** A participant in a room. */
export interface RoomParticipant {
  agentId: ResourceId;
  agent: Agent;
  role?: string;
}

/** Result of a room conversation round. */
export interface RoomRoundResult {
  agentId: ResourceId;
  agentName: string;
  content: string;
  durationMs: number;
}

/**
 * Multi-agent room — multiple agents collaborate in a shared context.
 *
 * Agents take turns responding to the conversation, each with their own
 * system prompt and persona, but sharing the same message history.
 *
 * Usage:
 * ```typescript
 * const room = new AgentRoom(dispatcher, agentManager);
 * room.addParticipant(researcherAgent);
 * room.addParticipant(criticAgent);
 *
 * const results = await room.discuss('What are the pros and cons of Rust vs Go?');
 * // Each agent contributes their perspective
 * ```
 */
export class AgentRoom {
  private _dispatcher: Dispatcher;
  private _agentManager: AgentManager;
  private _participants: Map<ResourceId, RoomParticipant>;
  private _history: Message[];
  private _logger: Logger;

  constructor(
    dispatcher: Dispatcher,
    agentManager: AgentManager,
    options: { logger?: Logger } = {}
  ) {
    this._dispatcher = dispatcher;
    this._agentManager = agentManager;
    this._participants = new Map();
    this._history = [];
    this._logger = options.logger ?? console;
  }

  /**
   * Add a participant agent to the room.
   */
  addParticipant(agent: Agent, role?: string): void {
    this._participants.set(agent.id, { agentId: agent.id, agent, role });
  }

  /**
   * Remove a participant.
   */
  removeParticipant(agentId: ResourceId): boolean {
    return this._participants.delete(agentId);
  }

  /**
   * Get all participants.
   */
  getParticipants(): RoomParticipant[] {
    return Array.from(this._participants.values());
  }

  /**
   * Run a discussion round — each agent responds to the topic.
   */
  async discuss(
    topic: string,
    options: { rounds?: number; userId?: string; requestContext?: any } = {}
  ): Promise<RoomRoundResult[]> {
    const rounds = options.rounds ?? 1;
    const results: RoomRoundResult[] = [];

    // Add the topic as user message
    this._history.push({ role: 'user', content: topic });

    for (let round = 0; round < rounds; round++) {
      for (const participant of this._participants.values()) {
        const started = Date.now();

        const systemPrompt = this._buildParticipantPrompt(participant);

        try {
          const response = await this._dispatcher.dispatch('', this._history, {
            systemPrompt,
            model: participant.agent.model,
            provider: participant.agent.provider,
            userId: options.userId,
            requestContext: options.requestContext,
          });

          const labeledContent = `[${participant.agent.name}]: ${response.content}`;
          this._history.push({ role: 'assistant', content: labeledContent });

          results.push({
            agentId: participant.agentId,
            agentName: participant.agent.name,
            content: response.content,
            durationMs: Date.now() - started,
          });
        } catch (error: any) {
          results.push({
            agentId: participant.agentId,
            agentName: participant.agent.name,
            content: `[Error: ${error?.message}]`,
            durationMs: Date.now() - started,
          });
        }
      }
    }

    return results;
  }

  /**
   * Get the room's conversation history.
   */
  getHistory(): Message[] {
    return [...this._history];
  }

  /**
   * Clear room history.
   */
  clearHistory(): void {
    this._history = [];
  }

  private _buildParticipantPrompt(participant: RoomParticipant): string {
    const parts: string[] = [];

    if (participant.agent.systemPrompt) {
      parts.push(participant.agent.systemPrompt);
    }

    parts.push(`You are "${participant.agent.name}" in a multi-agent discussion.`);

    if (participant.role) {
      parts.push(`Your role: ${participant.role}`);
    }

    const otherNames = Array.from(this._participants.values())
      .filter(p => p.agentId !== participant.agentId)
      .map(p => p.agent.name);

    if (otherNames.length > 0) {
      parts.push(`Other participants: ${otherNames.join(', ')}`);
    }

    parts.push('Respond with your perspective. Be concise and substantive.');

    return parts.join('\n\n');
  }
}
