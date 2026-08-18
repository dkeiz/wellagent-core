// ---------------------------------------------------------------------------
// lib/agents/manager.ts — Agent profiles backed by an explicit storage port
// ---------------------------------------------------------------------------

import type { AgentDefinition, Logger } from '../core/types';
import type { AgentStore, ResourceId, StoredAgent } from '../storage/ports';

export interface Agent extends StoredAgent {}

export class AgentManager {
  private _store: AgentStore;
  private _agents: Map<ResourceId, Agent>;
  private _nextId: number;
  private _logger: Logger;

  constructor(store: AgentStore = {}, options: { logger?: Logger } = {}) {
    this._store = store;
    this._agents = new Map();
    this._nextId = 1;
    this._logger = options.logger ?? console;
  }

  async init(): Promise<void> {
    if (!this._store.listAgents) return;

    const records = await this._store.listAgents();
    for (const record of records) {
      const agent: Agent = { ...record };
      this._agents.set(agent.id, agent);
      if (typeof agent.id === 'number' && agent.id >= this._nextId) {
        this._nextId = agent.id + 1;
      }
    }
    this._logger.log?.('[AgentManager] Loaded ' + this._agents.size + ' agents');
  }

  async create(definition: AgentDefinition): Promise<Agent> {
    const id = definition.id ?? this._nextId++;
    const now = new Date().toISOString();
    const agent: Agent = {
      ...definition,
      id,
      createdAt: now,
      updatedAt: now,
    };

    const persisted = this._store.saveAgent
      ? await this._store.saveAgent(agent)
      : agent;
    this._agents.set(persisted.id, { ...persisted });
    return { ...persisted };
  }

  async get(agentId: ResourceId): Promise<Agent | null> {
    const agent = this._agents.get(agentId);
    return agent ? { ...agent } : null;
  }

  async getByName(name: string): Promise<Agent | null> {
    const normalized = String(name || '').trim().toLowerCase();
    for (const agent of this._agents.values()) {
      if (agent.name.toLowerCase() === normalized) return { ...agent };
    }
    return null;
  }

  async list(_options?: { userId?: string }): Promise<Agent[]> {
    return Array.from(this._agents.values()).map(agent => ({ ...agent }));
  }

  async update(agentId: ResourceId, changes: Partial<AgentDefinition>): Promise<Agent | null> {
    const agent = this._agents.get(agentId);
    if (!agent) return null;

    const updated: Agent = {
      ...agent,
      ...changes,
      id: agentId,
      updatedAt: new Date().toISOString(),
    };
    const persisted = this._store.saveAgent
      ? await this._store.saveAgent(updated)
      : updated;
    this._agents.set(agentId, { ...persisted, id: agentId });
    return { ...persisted, id: agentId };
  }

  async delete(agentId: ResourceId): Promise<boolean> {
    if (!this._agents.has(agentId)) return false;
    if (this._store.deleteAgent) {
      const removed = await this._store.deleteAgent(agentId);
      if (!removed) return false;
    }
    this._agents.delete(agentId);
    return true;
  }

  get size(): number {
    return this._agents.size;
  }
}
