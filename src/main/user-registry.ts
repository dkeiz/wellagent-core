import type { UserIdentity } from '../../shared/types';
const { DEFAULT_USER_ID, normalizeOptionalUserId, normalizeUserId } = require('./user-scope');

export const DEFAULT_USER_ROLE: UserIdentity['role'] = 'owner';

export interface RegisteredUser extends UserIdentity {
  authProvider?: string;
  bio?: string;
  createdAt?: string;
  email?: string;
  isDefault?: boolean;
  status?: 'pending' | 'active' | 'suspended';
  updatedAt?: string;
}

export interface UserRegistryOverrides {
  authProvider?: string;
  bio?: string;
  displayName?: string;
  email?: string;
  isDefault?: boolean;
  role?: UserIdentity['role'];
  status?: 'pending' | 'active' | 'suspended';
  username?: string;
}

export interface UserRegistryOptions { [key: string]: any; db: any; }
export interface UserRegistry {
  ensureUser: (userId: string, overrides?: UserRegistryOverrides) => RegisteredUser;
  getDefaultUser: () => RegisteredUser;
  getUser: (userId: string) => RegisteredUser | null;
  listUsers: () => RegisteredUser[];
}

function optional(value: any): string | null {
  return String(value || '').trim() || null;
}

function role(value: any, fallback: UserIdentity['role']): UserIdentity['role'] {
  return value === 'member' || value === 'guest' || value === 'owner' ? value : fallback;
}

function status(value: any, fallback: 'pending' | 'active' | 'suspended'): 'pending' | 'active' | 'suspended' {
  return value === 'pending' || value === 'active' || value === 'suspended' ? value : fallback;
}

function displayName(userId: string): string {
  if (userId === DEFAULT_USER_ID) return 'Local User';
  return userId.split(/[._-]/g).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') || 'User';
}

function mapRow(row: any): RegisteredUser | null {
  if (!row) return null;
  const userId = normalizeUserId(row.user_id || row.userId);
  const userRole = role(row.role, userId === DEFAULT_USER_ID ? 'owner' : 'member');
  return {
    userId,
    role: userRole,
    username: optional(row.username) || undefined,
    displayName: optional(row.display_name || row.displayName) || displayName(userId),
    authProvider: optional(row.auth_provider || row.authProvider) || undefined,
    email: optional(row.email) || undefined,
    status: status(row.status, userId === DEFAULT_USER_ID ? 'active' : 'pending'),
    bio: optional(row.bio) || undefined,
    isDefault: Number(row.is_default || row.isDefault || 0) === 1,
    createdAt: optional(row.created_at || row.createdAt) || undefined,
    updatedAt: optional(row.updated_at || row.updatedAt) || undefined
  };
}

export function createUserRegistry(options: UserRegistryOptions): UserRegistry {
  const db = options?.db;
  if (!db?.get || !db?.all || !db?.run) throw new Error('db with get/all/run methods is required for user registry');

  function getUser(userId: string): RegisteredUser | null {
    const normalized = normalizeOptionalUserId(userId);
    return normalized ? mapRow(db.get('SELECT * FROM users WHERE user_id = ?', [normalized])) : null;
  }

  function ensureUser(userId: string, overrides: UserRegistryOverrides = {}): RegisteredUser {
    const normalized = normalizeUserId(userId);
    const existing = getUser(normalized);
    const isDefault = overrides.isDefault === undefined
      ? Boolean(existing?.isDefault || normalized === DEFAULT_USER_ID)
      : overrides.isDefault === true;
    const nextRole = role(overrides.role || existing?.role, normalized === DEFAULT_USER_ID ? 'owner' : 'member');
    const nextStatus = status(overrides.status || existing?.status, normalized === DEFAULT_USER_ID ? 'active' : 'pending');
    db.run(
      `INSERT INTO users (
        user_id, role, username, display_name, auth_provider, is_default,
        email, status, bio, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        role = excluded.role,
        username = excluded.username,
        display_name = excluded.display_name,
        auth_provider = excluded.auth_provider,
        is_default = excluded.is_default,
        email = COALESCE(excluded.email, users.email),
        status = excluded.status,
        bio = COALESCE(excluded.bio, users.bio),
        updated_at = CURRENT_TIMESTAMP`,
      [
        normalized,
        nextRole,
        optional(overrides.username || existing?.username) || normalized,
        optional(overrides.displayName || existing?.displayName) || displayName(normalized),
        optional(overrides.authProvider || existing?.authProvider) || (normalized === DEFAULT_USER_ID ? 'local-profile' : null),
        isDefault ? 1 : 0,
        optional(overrides.email || existing?.email),
        nextStatus,
        optional(overrides.bio || existing?.bio)
      ]
    );
    return getUser(normalized) as RegisteredUser;
  }

  function getDefaultUser(): RegisteredUser {
    return ensureUser(DEFAULT_USER_ID, {
      authProvider: 'local-profile', displayName: 'Local User', isDefault: true,
      role: 'owner', status: 'active', username: DEFAULT_USER_ID
    });
  }

  return {
    ensureUser,
    getDefaultUser,
    getUser,
    listUsers() {
      getDefaultUser();
      return db.all('SELECT * FROM users ORDER BY is_default DESC, display_name ASC, user_id ASC')
        .map(mapRow).filter(Boolean);
    }
  };
}
