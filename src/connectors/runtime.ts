// ---------------------------------------------------------------------------
// lib/connectors/runtime.ts — Opt-in connector host coordination
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import type { Dispatcher } from '../inference/dispatcher';
import type { DatabaseAdapter } from '../storage/database';
import type { Logger } from '../core/types';

export interface ConnectorHandle {
  stop?(): void | Promise<void>;
  getLogs?(): string[];
}

export interface ConnectorHost {
  start(input: {
    name: string;
    userId: string;
    options: Record<string, any>;
    dispatcher: Dispatcher;
    db: DatabaseAdapter;
  }): ConnectorHandle | Promise<ConnectorHandle>;
}

interface ConnectorState {
  name: string;
  userId: string;
  status: 'running' | 'stopped' | 'error';
  startedAt: string;
  error?: string;
  handle: ConnectorHandle;
}

export class ConnectorRuntime extends EventEmitter {
  private _dispatcher: Dispatcher;
  private _db: DatabaseAdapter;
  private _host: ConnectorHost | null;
  private _connectors: Map<string, ConnectorState>;
  private _logger: Logger;

  constructor(
    dispatcher: Dispatcher,
    db: DatabaseAdapter,
    options: { host?: ConnectorHost; logger?: Logger } = {}
  ) {
    super();
    this._dispatcher = dispatcher;
    this._db = db;
    this._host = options.host ?? null;
    this._connectors = new Map();
    this._logger = options.logger ?? console;
  }

  async start(name: string, userId: string, options: Record<string, any> = {}): Promise<void> {
    const key = this._instanceKey(name, userId);
    if (this._connectors.has(key)) {
      throw new Error('Connector "' + name + '" is already running for user "' + userId + '"');
    }
    if (!this._host) {
      throw new Error('ConnectorRuntime requires a host-supplied connector runner');
    }

    const state: ConnectorState = {
      name,
      userId,
      status: 'running',
      startedAt: new Date().toISOString(),
      handle: { },
    };
    this._connectors.set(key, state);

    try {
      state.handle = await this._host.start({
        name,
        userId,
        options,
        dispatcher: this._dispatcher,
        db: this._db,
      });
      this.emit('connector:started', { name, userId });
      this._logger.log?.('[ConnectorRuntime] Started "' + name + '" for user "' + userId + '"');
    } catch (error: any) {
      state.status = 'error';
      state.error = error?.message || String(error);
      this._connectors.delete(key);
      throw error;
    }
  }

  async stop(name: string, userId: string): Promise<void> {
    const key = this._instanceKey(name, userId);
    const state = this._connectors.get(key);
    if (!state) return;

    await state.handle.stop?.();
    state.status = 'stopped';
    this._connectors.delete(key);
    this.emit('connector:stopped', { name, userId });
  }

  list(userId?: string): Array<{ name: string; userId: string; status: string; startedAt: string }> {
    return Array.from(this._connectors.values())
      .filter(state => !userId || state.userId === userId)
      .map(state => ({
        name: state.name,
        userId: state.userId,
        status: state.status,
        startedAt: state.startedAt,
      }));
  }

  getLogs(name: string, userId: string): string[] {
    return this._connectors.get(this._instanceKey(name, userId))?.handle.getLogs?.() || [];
  }

  async stopAll(): Promise<void> {
    const active = Array.from(this._connectors.values());
    for (const state of active) await this.stop(state.name, state.userId);
  }

  private _instanceKey(name: string, userId: string): string {
    return userId + '::' + name;
  }
}
