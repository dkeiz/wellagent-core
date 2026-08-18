// ---------------------------------------------------------------------------
// lib/workflows/manager.ts — Workflow definitions backed by a storage port
// ---------------------------------------------------------------------------

import type { WorkflowDefinition, Logger } from '../core/types';
import type { ResourceId, StoredWorkflow, WorkflowStore } from '../storage/ports';

export interface Workflow extends StoredWorkflow {}

export class WorkflowManager {
  private _store: WorkflowStore;
  private _workflows: Map<ResourceId, Workflow>;
  private _nextId: number;
  private _logger: Logger;

  constructor(store: WorkflowStore = {}, options: { logger?: Logger } = {}) {
    this._store = store;
    this._workflows = new Map();
    this._nextId = 1;
    this._logger = options.logger ?? console;
  }

  async init(): Promise<void> {
    if (!this._store.listWorkflows) return;

    const records = await this._store.listWorkflows();
    for (const record of records) {
      const workflow: Workflow = { ...record };
      this._workflows.set(workflow.id, workflow);
      if (typeof workflow.id === 'number' && workflow.id >= this._nextId) {
        this._nextId = workflow.id + 1;
      }
    }
    this._logger.log?.('[WorkflowManager] Loaded ' + this._workflows.size + ' workflows');
  }

  async create(definition: WorkflowDefinition, options: { userId?: string } = {}): Promise<Workflow> {
    const id = definition.id ?? this._nextId++;
    const now = new Date().toISOString();
    const workflow: Workflow = {
      ...definition,
      id,
      createdAt: now,
      updatedAt: now,
      userId: options.userId,
    };

    const persisted = this._store.saveWorkflow
      ? await this._store.saveWorkflow(workflow)
      : workflow;
    this._workflows.set(persisted.id, { ...persisted });
    return { ...persisted };
  }

  async get(id: ResourceId): Promise<Workflow | null> {
    const workflow = this._workflows.get(id);
    return workflow ? { ...workflow } : null;
  }

  async list(options?: { userId?: string }): Promise<Workflow[]> {
    const workflows = Array.from(this._workflows.values());
    return workflows
      .filter(workflow => !options?.userId || workflow.userId === options.userId || !workflow.userId)
      .map(workflow => ({ ...workflow }));
  }

  async update(id: ResourceId, changes: Partial<WorkflowDefinition>): Promise<Workflow | null> {
    const workflow = this._workflows.get(id);
    if (!workflow) return null;

    const updated: Workflow = {
      ...workflow,
      ...changes,
      id,
      updatedAt: new Date().toISOString(),
    };
    const persisted = this._store.saveWorkflow
      ? await this._store.saveWorkflow(updated)
      : updated;
    this._workflows.set(id, { ...persisted, id });
    return { ...persisted, id };
  }

  async delete(id: ResourceId): Promise<boolean> {
    if (!this._workflows.has(id)) return false;
    if (this._store.deleteWorkflow) {
      const removed = await this._store.deleteWorkflow(id);
      if (!removed) return false;
    }
    this._workflows.delete(id);
    return true;
  }

  get size(): number {
    return this._workflows.size;
  }
}
