// ---------------------------------------------------------------------------
// lib/core/events.ts — Typed event bus
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import type { EventDefinition, Logger } from './types';

/**
 * Typed event bus with catalog, relay, and event log.
 *
 * Provides:
 * - `define()` to register event definitions with metadata
 * - `publish()` / `subscribe()` / `once()` for typed pub/sub
 * - `relay()` to bridge events to an external target (e.g. UI, IPC)
 * - Ring-buffer event log for debugging
 *
 * Usage:
 * ```typescript
 * const bus = new EventBus();
 * bus.define({
 *   'memory:saved':       { category: 'memory', description: 'Memory entry persisted' },
 *   'workflow:completed':  { category: 'workflow', description: 'Workflow run finished' },
 * });
 *
 * const unsub = bus.subscribe('memory:saved', (payload) => {
 *   console.log('Memory saved:', payload);
 * });
 *
 * bus.publish('memory:saved', { id: '123', content: 'User prefers dark mode' });
 * unsub(); // unsubscribe
 * ```
 */
export class EventBus {
  private _emitter: EventEmitter;
  private _catalog: Map<string, EventDefinition>;
  private _relayTargets: Array<{ send: (channel: string, payload: any) => boolean | void }>;
  private _eventLog: Array<{ event: string; payload: any; timestamp: string }>;
  private _maxLogSize: number;
  private _logger: Logger;

  constructor(options: { maxLogSize?: number; logger?: Logger } = {}) {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(100);
    this._catalog = new Map();
    this._relayTargets = [];
    this._eventLog = [];
    this._maxLogSize = options.maxLogSize ?? 200;
    this._logger = options.logger ?? console;
  }

  /**
   * Register event definitions in the catalog.
   * Definitions provide metadata (category, description) — they do not restrict publishing.
   */
  define(events: Record<string, EventDefinition>): void {
    for (const [name, def] of Object.entries(events)) {
      this._catalog.set(name, def);
    }
  }

  /**
   * Get the definition of a registered event, or null.
   */
  getDefinition(event: string): EventDefinition | null {
    return this._catalog.get(event) || null;
  }

  /**
   * Get all registered event definitions.
   */
  getCatalog(): Record<string, EventDefinition> {
    const result: Record<string, EventDefinition> = {};
    for (const [name, def] of this._catalog) {
      result[name] = def;
    }
    return result;
  }

  /**
   * Publish an event. All subscribers and relay targets are notified.
   */
  publish(event: string, payload?: any): void {
    // Log
    this._eventLog.push({
      event,
      payload,
      timestamp: new Date().toISOString(),
    });
    if (this._eventLog.length > this._maxLogSize) {
      this._eventLog.shift();
    }

    // Emit to subscribers
    try {
      this._emitter.emit(event, payload);
    } catch (error) {
      this._logger.error?.(`[EventBus] Error in handler for "${event}":`, error);
    }

    // Relay to external targets
    for (const target of this._relayTargets) {
      try {
        target.send(event, payload);
      } catch {
        // relay failures are non-fatal
      }
    }
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  subscribe(event: string, handler: (payload: any) => void): () => void {
    this._emitter.on(event, handler);
    return () => {
      this._emitter.removeListener(event, handler);
    };
  }

  /**
   * Subscribe to an event for a single firing. Returns an unsubscribe function.
   */
  once(event: string, handler: (payload: any) => void): () => void {
    this._emitter.once(event, handler);
    return () => {
      this._emitter.removeListener(event, handler);
    };
  }

  /**
   * Remove all listeners for a specific event, or all events if no name given.
   */
  removeAllListeners(event?: string): void {
    if (event) {
      this._emitter.removeAllListeners(event);
    } else {
      this._emitter.removeAllListeners();
    }
  }

  /**
   * Add a relay target. When events are published, they are also forwarded
   * to the relay target via `target.send(eventName, payload)`.
   *
   * Useful for bridging to UI layers (e.g. Electron IPC, WebSocket).
   */
  relay(target: { send: (channel: string, payload: any) => boolean | void }): () => void {
    this._relayTargets.push(target);
    return () => {
      const idx = this._relayTargets.indexOf(target);
      if (idx >= 0) this._relayTargets.splice(idx, 1);
    };
  }

  /**
   * Get recent events from the ring buffer log.
   */
  getLog(limit?: number): Array<{ event: string; payload: any; timestamp: string }> {
    const count = limit ?? this._eventLog.length;
    return this._eventLog.slice(-count);
  }

  /**
   * Clear the event log.
   */
  clearLog(): void {
    this._eventLog.length = 0;
  }

  /**
   * Get the number of listeners for an event.
   */
  listenerCount(event: string): number {
    return this._emitter.listenerCount(event);
  }
}
