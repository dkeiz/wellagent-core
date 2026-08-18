// ---------------------------------------------------------------------------
// lib/core/settings.ts — Scoped settings access (the 8-file pattern, unified)
// ---------------------------------------------------------------------------

import type { ScopeOptions, SettingsStore } from './types';

/**
 * Build normalized scope options from arbitrary option bags.
 *
 * Handles the common patterns found across the codebase:
 * - `{ userId, requestContext }`
 * - `{ scopeOptions: { userId, requestContext } }`
 * - `{ dbQueryOptions: { userId } }`
 */
export function buildScopeOptions(options: any = {}): ScopeOptions {
  const scope = options?.scopeOptions || options?.dbQueryOptions || options || {};
  const userId = String(scope?.userId || '').trim();
  return {
    requestContext: scope?.requestContext || null,
    userId: userId || undefined,
  };
}

/**
 * Read a setting, falling back from scoped → global.
 */
export async function getScopedSetting(
  store: SettingsStore,
  key: string,
  options: any = {}
): Promise<string | null> {
  const scope = buildScopeOptions(options);
  if (store.getScopedSetting && (scope.requestContext || scope.userId)) {
    const value = await store.getScopedSetting(key, scope);
    if (value !== null && value !== undefined) return value;
  }
  return store.getSetting(key) as Promise<string | null>;
}

/**
 * Save a setting, using scoped save when available.
 */
export async function saveScopedSetting(
  store: SettingsStore,
  key: string,
  value: string,
  options: any = {}
): Promise<void> {
  const scope = buildScopeOptions(options);
  if (store.saveScopedSetting && (scope.requestContext || scope.userId)) {
    return store.saveScopedSetting(key, value, scope) as Promise<void>;
  }
  return store.saveSetting(key, value) as Promise<void>;
}

/**
 * Delete a setting, using scoped delete when available.
 */
export async function deleteScopedSetting(
  store: SettingsStore,
  key: string,
  options: any = {}
): Promise<void> {
  const scope = buildScopeOptions(options);
  if (store.deleteScopedSetting && (scope.requestContext || scope.userId)) {
    return store.deleteScopedSetting(key, scope) as Promise<void>;
  }
  if (store.deleteSetting) {
    return store.deleteSetting(key) as Promise<void>;
  }
}

// ---------------------------------------------------------------------------
// ScopedSettingsAccessor — mixin base class
// ---------------------------------------------------------------------------

/**
 * Base class that provides `_buildScopeOptions`, `_getSetting`, `_saveSetting`,
 * and `_deleteSetting` methods — the pattern currently duplicated in 8+ files
 * across the application.
 *
 * Services that need settings access extend this class:
 * ```typescript
 * class MyService extends ScopedSettingsAccessor {
 *   constructor(db: SettingsStore) {
 *     super(db);
 *   }
 *
 *   async doSomething(options = {}) {
 *     const value = await this._getSetting('my.key', options);
 *     // ...
 *   }
 * }
 * ```
 *
 * The method signatures intentionally match the existing pattern so that
 * migrating a service is as simple as adding `extends ScopedSettingsAccessor`
 * and removing the copy-pasted methods.
 */
export class ScopedSettingsAccessor {
  protected db: SettingsStore;

  constructor(db: SettingsStore) {
    this.db = db;
  }

  protected _buildScopeOptions(options: any = {}): ScopeOptions {
    return buildScopeOptions(options);
  }

  protected async _getSetting(key: string, options: any = {}): Promise<string | null> {
    return getScopedSetting(this.db, key, options);
  }

  protected async _saveSetting(key: string, value: string, options: any = {}): Promise<void> {
    return saveScopedSetting(this.db, key, value, options);
  }

  protected async _deleteSetting(key: string, options: any = {}): Promise<void> {
    return deleteScopedSetting(this.db, key, options);
  }
}
