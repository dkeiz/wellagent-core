// ---------------------------------------------------------------------------
// lib/plugins/manager.ts — Plugin lifecycle management
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import type { ToolRegistry } from '../tools/registry';
import type { DatabaseAdapter } from '../storage/database';
import type { PluginManifest, PluginInfo, Logger } from '../core/types';
import { ContractRegistry } from './contracts';
import * as fs from 'fs';
import * as path from 'path';

/** Plugin runtime state. */
interface PluginState {
  manifest: PluginManifest;
  status: 'enabled' | 'disabled' | 'error';
  module: LoadedPluginModule | null;
  handlers: string[];
  error?: string;
  runtimeUserId?: string;
}

export interface LoadedPluginModule {
  onEnable?(context: Record<string, any>): void | Promise<void>;
  onDisable?(): void | Promise<void>;
}

export interface PluginModuleLoader {
  load(modulePath: string): LoadedPluginModule | Promise<LoadedPluginModule>;
}

export interface PluginExecutionPolicy {
  allowPlugin(manifest: PluginManifest): boolean | Promise<boolean>;
}

/**
 * Discovers, validates, and manages plugins.
 *
 * Plugins live in a directory (one subdirectory per plugin, with a `plugin.json` manifest).
 * When enabled, their `main.js` is loaded and `onEnable(context)` is called.
 * Plugins register tool handlers via `context.registerHandler()` which delegates
 * to the ToolRegistry.
 *
 * Usage:
 * ```typescript
 * const plugins = new PluginManager({
 *   pluginsDir: './plugins',
 *   toolRegistry: registry,
 *   db: database,
 * });
 * await plugins.discover();
 * await plugins.enable('my-plugin');
 * ```
 */
export class PluginManager extends EventEmitter {
  private _pluginsDir: string;
  private _registry: ToolRegistry;
  private _db: DatabaseAdapter;
  private _contracts: ContractRegistry;
  private _plugins: Map<string, PluginState>;
  private _logger: Logger;
  private _loader: PluginModuleLoader | null;
  private _policy: PluginExecutionPolicy | null;

  constructor(options: {
    pluginsDir: string;
    toolRegistry: ToolRegistry;
    db: DatabaseAdapter;
    contracts?: ContractRegistry;
    loader?: PluginModuleLoader;
    policy?: PluginExecutionPolicy;
    logger?: Logger;
  }) {
    super();
    this._pluginsDir = options.pluginsDir;
    this._registry = options.toolRegistry;
    this._db = options.db;
    this._contracts = options.contracts ?? new ContractRegistry();
    this._plugins = new Map();
    this._logger = options.logger ?? console;
    this._loader = options.loader ?? null;
    this._policy = options.policy ?? null;
  }

  /**
   * Discover plugins in the plugins directory.
   */
  async discover(): Promise<PluginManifest[]> {
    const discovered: PluginManifest[] = [];

    try {
      if (!fs.existsSync(this._pluginsDir)) return discovered;
      const entries = fs.readdirSync(this._pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const manifestPath = path.join(this._pluginsDir, entry.name, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const raw = fs.readFileSync(manifestPath, 'utf-8');
          const manifest: PluginManifest = JSON.parse(raw);
          manifest.id = manifest.id || entry.name;
          discovered.push(manifest);

          if (!this._plugins.has(manifest.id)) {
            this._plugins.set(manifest.id, {
              manifest,
              status: 'disabled',
              module: null,
              handlers: [],
            });
          }
        } catch (error: any) {
          this._logger.warn?.(`[PluginManager] Invalid manifest in ${entry.name}:`, error?.message);
        }
      }
    } catch (error: any) {
      this._logger.error?.(`[PluginManager] Discovery failed:`, error?.message);
    }

    this._logger.log?.(`[PluginManager] Discovered ${discovered.length} plugins`);
    return discovered;
  }

  /**
   * Enable a plugin.
   */
  async enable(pluginId: string, options: { userId?: string } = {}): Promise<void> {
    const state = this._plugins.get(pluginId);
    if (!state) throw new Error(`Plugin "${pluginId}" not found`);
    if (state.status === 'enabled') return;

    const pluginDir = path.join(this._pluginsDir, pluginId);
    const mainFile = path.join(pluginDir, state.manifest.main || 'main.js');
    if (!this._loader) {
      throw new Error('PluginManager requires a host-supplied module loader');
    }
    if (this._policy && !(await this._policy.allowPlugin(state.manifest))) {
      throw new Error('Plugin policy denied "' + pluginId + '"');
    }

    try {
      const pluginModule = await this._loader.load(mainFile);

      // Build the context object passed to the plugin
      const context = {
        pluginId,
        pluginDir,
        manifest: state.manifest,
        db: this._db,
        registerHandler: (name: string, handler: any) => {
          const toolName = `${pluginId}_${name}`;
          this._registry.register({
            name: toolName,
            description: `[Plugin: ${pluginId}] ${name}`,
            handler,
            group: 'plugin',
            source: 'plugin',
            pluginId,
          });
          state.handlers.push(toolName);
        },
        log: (...args: any[]) => this._logger.log?.(`[Plugin:${pluginId}]`, ...args),
      };

      if (typeof pluginModule.onEnable === 'function') {
        await pluginModule.onEnable(context);
      }

      state.module = pluginModule;
      state.status = 'enabled';
      state.runtimeUserId = options.userId;

      this.emit('plugin:enabled', { pluginId });
      this._logger.log?.(`[PluginManager] Enabled "${pluginId}" (${state.handlers.length} handlers)`);
    } catch (error: any) {
      state.status = 'error';
      state.error = error?.message || String(error);
      this._logger.error?.(`[PluginManager] Failed to enable "${pluginId}":`, state.error);
      throw error;
    }
  }

  /**
   * Disable a plugin.
   */
  async disable(pluginId: string): Promise<void> {
    const state = this._plugins.get(pluginId);
    if (!state || state.status !== 'enabled') return;

    // Call onDisable if available
    if (state.module && typeof state.module.onDisable === 'function') {
      try {
        await state.module.onDisable();
      } catch (error: any) {
        this._logger.warn?.(`[PluginManager] onDisable failed for "${pluginId}":`, error?.message);
      }
    }

    // Unregister handlers
    for (const handlerName of state.handlers) {
      this._registry.unregister(handlerName);
    }

    state.handlers = [];
    state.module = null;
    state.status = 'disabled';

    this.emit('plugin:disabled', { pluginId });
  }

  /**
   * Get plugin info.
   */
  getInfo(pluginId: string): PluginInfo | null {
    const state = this._plugins.get(pluginId);
    if (!state) return null;
    return {
      id: pluginId,
      manifest: state.manifest,
      status: state.status,
      error: state.error,
    };
  }

  /**
   * List all plugins.
   */
  list(): PluginInfo[] {
    return Array.from(this._plugins.entries()).map(([id, state]) => ({
      id,
      manifest: state.manifest,
      status: state.status,
      error: state.error,
    }));
  }

  /**
   * Get the contract registry.
   */
  get contracts(): ContractRegistry {
    return this._contracts;
  }
}
