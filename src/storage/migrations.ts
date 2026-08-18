// ---------------------------------------------------------------------------
// lib/storage/migrations.ts — Schema migration system
// ---------------------------------------------------------------------------

import type { DatabaseAdapter } from './database';
import type { Logger } from '../core/types';

/** A single migration step. */
export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseAdapter): void | Promise<void>;
}

/**
 * Runs ordered, versioned migrations against a database.
 *
 * Usage:
 * ```typescript
 * const runner = new MigrationRunner();
 * runner.register({ version: 1, name: 'create_sessions', up: (db) => { ... } });
 * runner.register({ version: 2, name: 'add_user_id', up: (db) => { ... } });
 * const result = await runner.run(db);
 * // result.applied = ['create_sessions', 'add_user_id']
 * ```
 */
export class MigrationRunner {
  private _migrations: Migration[];
  private _tableName: string;
  private _logger: Logger;

  constructor(options: { tableName?: string; logger?: Logger } = {}) {
    this._migrations = [];
    this._tableName = options.tableName ?? '_migrations';
    this._logger = options.logger ?? console;
  }

  /**
   * Register a migration. Migrations are applied in version order.
   */
  register(migration: Migration): this {
    this._migrations.push(migration);
    this._migrations.sort((a, b) => a.version - b.version);
    return this;
  }

  /**
   * Register multiple migrations at once.
   */
  registerAll(migrations: Migration[]): this {
    for (const m of migrations) {
      this.register(m);
    }
    return this;
  }

  /**
   * Run all pending migrations.
   * Returns the list of applied migration names.
   */
  async run(db: DatabaseAdapter): Promise<{ applied: string[] }> {
    // Ensure migration tracking table exists
    if (db.run) {
      db.run(`CREATE TABLE IF NOT EXISTS ${this._tableName} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`);
    }

    const appliedVersions = new Set<number>();
    if (db.all) {
      const rows = db.all(`SELECT version FROM ${this._tableName}`);
      for (const row of rows) {
        appliedVersions.add(Number(row.version));
      }
    }

    const applied: string[] = [];

    for (const migration of this._migrations) {
      if (appliedVersions.has(migration.version)) continue;

      this._logger.log?.(`[Migrations] Applying v${migration.version}: ${migration.name}`);
      try {
        await migration.up(db);

        if (db.run) {
          db.run(
            `INSERT INTO ${this._tableName} (version, name, applied_at) VALUES (?, ?, ?)`,
            [migration.version, migration.name, new Date().toISOString()]
          );
        }

        applied.push(migration.name);
      } catch (error: any) {
        this._logger.error?.(`[Migrations] Failed v${migration.version} "${migration.name}":`, error?.message || error);
        throw error;
      }
    }

    if (applied.length > 0) {
      this._logger.log?.(`[Migrations] Applied ${applied.length} migration(s)`);
    }

    return { applied };
  }

  /**
   * Get all registered migrations.
   */
  list(): Migration[] {
    return [...this._migrations];
  }

  /**
   * Get the current version (highest applied migration).
   */
  getCurrentVersion(db: DatabaseAdapter): number {
    if (!db.get) return 0;
    try {
      const row = db.get(`SELECT MAX(version) as version FROM ${this._tableName}`);
      return Number(row?.version || 0);
    } catch {
      return 0;
    }
  }
}
