class ServiceContainer {
  private _services: Map<string, any>;

  constructor() {
    this._services = new Map();
  }

  register(name: string, instance: any): this {
    if (this._services.has(name)) {
      throw new Error(`[ServiceContainer] Service "${name}" is already registered`);
    }
    this._services.set(name, instance);
    return this;
  }

  replace(name: string, instance: any): this {
    this._services.set(name, instance);
    return this;
  }

  get<T = any>(name: string): T {
    if (!this._services.has(name)) {
      throw new Error(`[ServiceContainer] Service "${name}" not registered`);
    }
    return this._services.get(name) as T;
  }

  has(name: string): boolean {
    return this._services.has(name);
  }

  /**
   * Get a service or return null if not registered.
   * Useful for optional services.
   */
  optional<T = any>(name: string): T | null {
    return this._services.has(name) ? (this._services.get(name) as T) : null;
  }

  keys(): string[] {
    return Array.from(this._services.keys()).sort();
  }
}

export = ServiceContainer;
