// ---------------------------------------------------------------------------
// lib/core/container.ts — Dependency injection container
// ---------------------------------------------------------------------------

/**
 * Lightweight service container for dependency injection.
 *
 * Services are registered by name and retrieved by name.
 * Supports register-once, replace, optional retrieval, and key listing.
 *
 * Usage:
 * ```typescript
 * const container = new Container();
 * container.register('db', new Database());
 * container.register('ai', new AIService());
 *
 * const db = container.get<Database>('db');
 * const optional = container.optional<Logger>('logger'); // null if not registered
 * ```
 */
export class Container {
  private _services: Map<string, any>;

  constructor() {
    this._services = new Map();
  }

  /**
   * Register a service. Throws if the name is already taken.
   * Use `replace()` to overwrite an existing service.
   */
  register<T = any>(name: string, instance: T): this {
    if (this._services.has(name)) {
      throw new Error(`[Container] Service "${name}" is already registered`);
    }
    this._services.set(name, instance);
    return this;
  }

  /**
   * Replace a service (or register it if not yet present).
   */
  replace<T = any>(name: string, instance: T): this {
    this._services.set(name, instance);
    return this;
  }

  /**
   * Register a service if not already present, or replace it if it is.
   * Convenience method combining register/replace.
   */
  registerOrReplace<T = any>(name: string, instance: T): this {
    this._services.set(name, instance);
    return this;
  }

  /**
   * Retrieve a service by name. Throws if not registered.
   */
  get<T = any>(name: string): T {
    if (!this._services.has(name)) {
      throw new Error(`[Container] Service "${name}" not registered`);
    }
    return this._services.get(name) as T;
  }

  /**
   * Retrieve a service by name, or null if not registered.
   * Useful for optional dependencies.
   */
  optional<T = any>(name: string): T | null {
    return this._services.has(name) ? (this._services.get(name) as T) : null;
  }

  /**
   * Check if a service is registered.
   */
  has(name: string): boolean {
    return this._services.has(name);
  }

  /**
   * Remove a service registration.
   */
  remove(name: string): boolean {
    return this._services.delete(name);
  }

  /**
   * List all registered service names (sorted).
   */
  keys(): string[] {
    return Array.from(this._services.keys()).sort();
  }

  /**
   * Total number of registered services.
   */
  get size(): number {
    return this._services.size;
  }

  /**
   * Clear all registrations.
   */
  clear(): void {
    this._services.clear();
  }
}
