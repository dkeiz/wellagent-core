// ---------------------------------------------------------------------------
// lib/auth/user-registry.ts — Multi-user registry
// ---------------------------------------------------------------------------

import type { SettingsStore, Logger, RequestContext } from '../core/types';
import { ScopedSettingsAccessor } from '../core/settings';

export const DEFAULT_USER_ID = 'localuser';

export type UserRole = 'owner' | 'member' | 'guest';
export type UserStatus = 'pending' | 'active' | 'suspended';

export interface RegisteredUser {
  userId: string;
  role: UserRole;
  username?: string;
  displayName?: string;
  profileId?: string;
  authProvider?: string;
  email?: string;
  bio?: string;
  status?: UserStatus;
  isDefault?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserRegistryOverrides {
  role?: UserRole;
  username?: string;
  displayName?: string;
  profileId?: string | null;
  authProvider?: string;
  email?: string;
  bio?: string;
  status?: UserStatus;
  isDefault?: boolean;
}

/**
 * Multi-user registry — stores, retrieves, and manages user identities.
 *
 * Backed by the SettingsStore. Suitable for both single-user desktop
 * and multi-user headless/server deployments.
 *
 * Usage:
 * ```typescript
 * const registry = new UserRegistry(db);
 * const user = registry.ensureUser('alice', { role: 'member', displayName: 'Alice' });
 * const all = registry.listUsers();
 * ```
 */
export class UserRegistry extends ScopedSettingsAccessor {
  private _users: Map<string, RegisteredUser>;
  private _defaultProfileId: string | null;
  private _logger: Logger;
  private _persistKey = 'auth.users.v1';

  constructor(db: SettingsStore, options: { defaultProfileId?: string; logger?: Logger } = {}) {
    super(db);
    this._users = new Map();
    this._defaultProfileId = options.defaultProfileId ?? null;
    this._logger = options.logger ?? console;
  }

  /**
   * Load persisted users from settings store.
   */
  async init(): Promise<void> {
    try {
      const raw = await this._getSetting(this._persistKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const u of parsed) {
            if (u.userId) this._users.set(u.userId, u);
          }
        }
      }
    } catch { /* cold start */ }

    // Ensure default user exists
    this.ensureUser(DEFAULT_USER_ID, {
      role: 'owner',
      displayName: 'Local User',
      isDefault: true,
      authProvider: 'local-profile',
      profileId: this._defaultProfileId || undefined,
    });
  }

  /**
   * Get or create a user. Merges overrides with existing data.
   */
  ensureUser(userId: string, overrides: UserRegistryOverrides = {}): RegisteredUser {
    const id = normalizeUserId(userId);
    const existing = this._users.get(id);
    const now = new Date().toISOString();

    const user: RegisteredUser = {
      userId: id,
      role: normalizeRole(overrides.role || existing?.role, id === DEFAULT_USER_ID ? 'owner' : 'member'),
      username: normalizeOpt(overrides.username || existing?.username || id) || undefined,
      displayName: normalizeOpt(overrides.displayName || existing?.displayName) || defaultDisplayName(id),
      profileId: overrides.profileId !== undefined
        ? (normalizeOpt(overrides.profileId) || undefined)
        : (existing?.profileId || undefined),
      authProvider: normalizeOpt(overrides.authProvider || existing?.authProvider) || undefined,
      email: normalizeOpt(overrides.email || existing?.email) || undefined,
      bio: normalizeOpt(overrides.bio || existing?.bio) || undefined,
      status: normalizeStatus(overrides.status || existing?.status, id === DEFAULT_USER_ID ? 'active' : 'pending'),
      isDefault: overrides.isDefault ?? existing?.isDefault ?? (id === DEFAULT_USER_ID),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this._users.set(id, user);
    this._persistAsync();
    return user;
  }

  /**
   * Get a user by ID.
   */
  getUser(userId: string): RegisteredUser | null {
    return this._users.get(normalizeUserId(userId)) ?? null;
  }

  /**
   * Get the default user.
   */
  getDefaultUser(): RegisteredUser {
    return this.ensureUser(DEFAULT_USER_ID);
  }

  /**
   * Get a user by profile ID.
   */
  getUserByProfileId(profileId: string): RegisteredUser | null {
    const pid = normalizeOpt(profileId);
    if (!pid) return null;
    for (const user of this._users.values()) {
      if (user.profileId === pid) return user;
    }
    return null;
  }

  /**
   * List all registered users (default user first).
   */
  listUsers(): RegisteredUser[] {
    this.getDefaultUser(); // Ensure default exists
    return Array.from(this._users.values()).sort((a, b) => {
      if (a.userId === DEFAULT_USER_ID) return -1;
      if (b.userId === DEFAULT_USER_ID) return 1;
      return (a.displayName || a.userId).localeCompare(b.displayName || b.userId);
    });
  }

  /**
   * Remove a user (cannot remove default user).
   */
  removeUser(userId: string): boolean {
    const id = normalizeUserId(userId);
    if (id === DEFAULT_USER_ID) return false;
    const removed = this._users.delete(id);
    if (removed) this._persistAsync();
    return removed;
  }

  /**
   * Check if a userId is the built-in default.
   */
  isBuiltInUser(userId: string): boolean {
    return normalizeUserId(userId) === DEFAULT_USER_ID;
  }

  private _persistAsync(): void {
    this._saveSetting(this._persistKey, JSON.stringify(Array.from(this._users.values()))).catch(() => {});
  }
}

// ---- Helpers ----

function normalizeUserId(value: any): string {
  const s = String(value || '').trim().toLowerCase();
  return s || DEFAULT_USER_ID;
}

function normalizeOpt(value: any): string | null {
  const s = String(value || '').trim();
  return s || null;
}

function normalizeRole(value: any, fallback: UserRole = 'member'): UserRole {
  return value === 'owner' || value === 'member' || value === 'guest' ? value : fallback;
}

function normalizeStatus(value: any, fallback: UserStatus = 'active'): UserStatus {
  return value === 'pending' || value === 'active' || value === 'suspended' ? value : fallback;
}

function defaultDisplayName(userId: string): string {
  if (userId === DEFAULT_USER_ID) return 'Local User';
  return userId.split(/[._-]/g).filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ') || 'User';
}
