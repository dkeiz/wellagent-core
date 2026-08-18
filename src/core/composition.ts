// ---------------------------------------------------------------------------
// lib/core/composition.ts — Declarative runtime assembly and lifecycle
// ---------------------------------------------------------------------------

import { Container } from './container';
import { EventBus } from './events';
import type { Logger } from './types';

export interface RuntimeModuleContext {
  readonly blueprint: RuntimeBlueprint;
  readonly container: Container;
  readonly events: EventBus;
  readonly logger: Logger;
}

export interface RuntimeModule {
  id: string;
  requires?: string[];
  register?(context: RuntimeModuleContext): void | Promise<void>;
  start?(context: RuntimeModuleContext): void | Promise<void>;
  stop?(context: RuntimeModuleContext): void | Promise<void>;
}

export interface RuntimeBlueprint {
  id?: string;
  services?: Record<string, unknown>;
  modules?: RuntimeModule[];
  logger?: Logger;
}

export interface RuntimeHandle extends RuntimeModuleContext {
  readonly id: string;
  readonly isStarted: boolean;
  readonly moduleIds: string[];
  start(): Promise<void>;
  shutdown(): Promise<void>;
  getModule(id: string): RuntimeModule | null;
}

type RuntimeState = 'created' | 'starting' | 'started' | 'stopping' | 'stopped';

class ComposedRuntime implements RuntimeHandle {
  readonly blueprint: RuntimeBlueprint;
  readonly container: Container;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly id: string;
  readonly moduleIds: string[];

  private readonly _modules: RuntimeModule[];
  private _startedModules: RuntimeModule[] = [];
  private _state: RuntimeState = 'created';
  private _startPromise: Promise<void> | null = null;
  private _shutdownPromise: Promise<void> | null = null;

  constructor(blueprint: RuntimeBlueprint) {
    this.blueprint = blueprint;
    this.id = String(blueprint.id || 'runtime').trim() || 'runtime';
    this.logger = blueprint.logger ?? console;
    this.container = new Container();
    this.events = new EventBus({ logger: this.logger });
    this._modules = orderModules(blueprint.modules || []);
    this.moduleIds = this._modules.map(module => module.id);

    this.container.register('runtime', this);
    this.container.register('eventBus', this.events);
    for (const [name, service] of Object.entries(blueprint.services || {})) {
      this.container.register(name, service);
    }
  }

  get isStarted(): boolean {
    return this._state === 'started';
  }

  getModule(id: string): RuntimeModule | null {
    return this._modules.find(module => module.id === id) ?? null;
  }

  async start(): Promise<void> {
    if (this._state === 'started') return;
    if (this._startPromise) return this._startPromise;
    if (this._state === 'stopping') throw new Error('Runtime is stopping');

    this._state = 'starting';
    this._startPromise = this._start();
    try {
      await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async shutdown(): Promise<void> {
    if (this._shutdownPromise) return this._shutdownPromise;
    if (this._state === 'created' || this._state === 'stopped') return;

    this._state = 'stopping';
    this._shutdownPromise = (async () => {
      let failure: unknown = null;
      try {
        await this._stopStartedModules();
      } catch (error) {
        failure = error;
      }
      this._state = 'stopped';
      this.events.publish('runtime:stopped', { runtimeId: this.id });
      if (failure) throw failure;
    })();
    try {
      await this._shutdownPromise;
    } finally {
      this._shutdownPromise = null;
    }
  }

  private async _start(): Promise<void> {
    try {
      for (const module of this._modules) await module.register?.(this);
      for (const module of this._modules) {
        await module.start?.(this);
        this._startedModules.push(module);
      }
      this._state = 'started';
      this.events.publish('runtime:started', { runtimeId: this.id, modules: this.moduleIds });
    } catch (error) {
      try {
        await this._stopStartedModules();
      } catch (stopError) {
        this.logger.error?.('[Runtime] Failed while rolling back startup', stopError);
      }
      this._state = 'stopped';
      this.events.publish('runtime:failed', { runtimeId: this.id, error });
      throw error;
    }
  }

  private async _stopStartedModules(): Promise<void> {
    const failures: unknown[] = [];
    for (const module of [...this._startedModules].reverse()) {
      try {
        await module.stop?.(this);
      } catch (error) {
        failures.push(error);
        this.logger.error?.('[Runtime] Failed to stop module "' + module.id + '"', error);
      }
    }
    this._startedModules = [];
    if (failures.length > 0) throw failures[0];
  }
}

export function createRuntime(blueprint: RuntimeBlueprint = {}): RuntimeHandle {
  return new ComposedRuntime(blueprint);
}

function orderModules(modules: RuntimeModule[]): RuntimeModule[] {
  const byId = new Map<string, RuntimeModule>();
  for (const module of modules) {
    const id = String(module?.id || '').trim();
    if (!id) throw new Error('Runtime modules require a non-empty id');
    if (byId.has(id)) throw new Error('Runtime module "' + id + '" is registered more than once');
    byId.set(id, module);
  }

  const ordered: RuntimeModule[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Runtime module dependency cycle includes "' + id + '"');
    const module = byId.get(id);
    if (!module) throw new Error('Runtime module dependency "' + id + '" is not registered');
    visiting.add(id);
    for (const dependency of module.requires || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(module);
  };

  for (const module of modules) visit(module.id);
  return ordered;
}
