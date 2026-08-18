// ---------------------------------------------------------------------------
// lib/a2a/manager.ts — A2A task lifecycle and target registry
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import type {
  A2ATarget, A2ATask, A2ATaskStatus, A2AAgentCard,
  A2AMessage, A2ACapability,
} from './types';
import type { Logger } from '../core/types';
import { generateId } from '../core/config';

/**
 * Manages A2A (Agent-to-Agent) protocol interactions.
 *
 * - Registers local agent card (what this agent exposes)
 * - Tracks known remote targets
 * - Creates and manages tasks (outgoing and incoming)
 *
 * Usage:
 * ```typescript
 * const a2a = new A2AManager({
 *   agentCard: { name: 'Research Agent', capabilities: [{ name: 'search' }] },
 * });
 * a2a.registerTarget({ id: 'helper', name: 'Helper Agent', url: 'http://10.0.0.5:8789' });
 * const task = await a2a.createTask('helper', { query: 'latest AI news' });
 * ```
 */
export class A2AManager extends EventEmitter {
  private _agentCard: A2AAgentCard;
  private _targets: Map<string, A2ATarget>;
  private _tasks: Map<string, A2ATask>;
  private _messages: Map<string, A2AMessage[]>;
  private _logger: Logger;

  constructor(options: { agentCard?: A2AAgentCard; logger?: Logger } = {}) {
    super();
    this._agentCard = options.agentCard || { name: 'Agent' };
    this._targets = new Map();
    this._tasks = new Map();
    this._messages = new Map();
    this._logger = options.logger ?? console;
  }

  // ---- Agent Card ----

  /**
   * Get the local agent card.
   */
  getAgentCard(): A2AAgentCard {
    return { ...this._agentCard };
  }

  /**
   * Update the local agent card.
   */
  setAgentCard(card: A2AAgentCard): void {
    this._agentCard = card;
  }

  // ---- Targets ----

  /**
   * Register a remote A2A target.
   */
  registerTarget(target: A2ATarget): void {
    target.discoveredAt = target.discoveredAt || new Date().toISOString();
    target.status = target.status || 'unknown';
    this._targets.set(target.id, target);
    this.emit('target:registered', { targetId: target.id });
  }

  /**
   * Remove a target.
   */
  removeTarget(targetId: string): boolean {
    return this._targets.delete(targetId);
  }

  /**
   * Get a target by ID.
   */
  getTarget(targetId: string): A2ATarget | null {
    return this._targets.get(targetId) ?? null;
  }

  /**
   * List all known targets.
   */
  listTargets(): A2ATarget[] {
    return Array.from(this._targets.values());
  }

  /**
   * Discover a remote agent by fetching its agent card.
   */
  async discoverTarget(url: string): Promise<A2ATarget | null> {
    try {
      const cardUrl = `${url.replace(/\/+$/, '')}/.well-known/agent.json`;
      const response = await fetch(cardUrl, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return null;

      const card: any = await response.json();
      const target: A2ATarget = {
        id: card.name || url,
        name: card.name || 'Unknown Agent',
        description: card.description,
        url,
        capabilities: card.capabilities || [],
        discoveredAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: 'online',
      };

      this.registerTarget(target);
      return target;
    } catch (error: any) {
      this._logger.warn?.(`[A2A] Discovery failed for ${url}:`, error?.message);
      return null;
    }
  }

  // ---- Tasks ----

  /**
   * Create an outgoing task to a remote target.
   */
  async createTask(targetId: string, input: any, options: { sessionId?: string; userId?: string } = {}): Promise<A2ATask> {
    const task: A2ATask = {
      id: generateId('a2a'),
      targetId,
      status: 'pending',
      input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionId: options.sessionId,
      userId: options.userId,
    };

    this._tasks.set(task.id, task);
    this._messages.set(task.id, []);
    this.emit('task:created', task);
    return task;
  }

  /**
   * Update a task's status.
   */
  updateTask(taskId: string, patch: Partial<A2ATask>): A2ATask | null {
    const task = this._tasks.get(taskId);
    if (!task) return null;

    Object.assign(task, patch, { updatedAt: new Date().toISOString() });

    if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'cancelled') {
      task.completedAt = new Date().toISOString();
    }

    this.emit('task:updated', task);
    return task;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): A2ATask | null {
    return this._tasks.get(taskId) ?? null;
  }

  /**
   * List tasks, optionally filtered.
   */
  listTasks(filters?: { targetId?: string; status?: A2ATaskStatus }): A2ATask[] {
    let tasks = Array.from(this._tasks.values());
    if (filters?.targetId) tasks = tasks.filter(t => t.targetId === filters.targetId);
    if (filters?.status) tasks = tasks.filter(t => t.status === filters.status);
    return tasks;
  }

  /**
   * Add a message to a task conversation.
   */
  addMessage(taskId: string, message: Omit<A2AMessage, 'taskId'>): void {
    const messages = this._messages.get(taskId);
    if (!messages) return;

    const full: A2AMessage = {
      ...message,
      taskId,
      timestamp: message.timestamp || new Date().toISOString(),
    };
    messages.push(full);
    this.emit('task:message', full);
  }

  /**
   * Get messages for a task.
   */
  getMessages(taskId: string): A2AMessage[] {
    return this._messages.get(taskId) || [];
  }
}
