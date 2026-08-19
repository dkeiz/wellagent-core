// @ts-nocheck
import type { RequestContext } from '../../shared/types';
const { DEFAULT_USER_ID, normalizeOptionalUserId } = require('./user-scope');

export interface SharedWwwGateUser {
  id: string;
  userId: string;
  email: string;
  display_name: string;
  displayName: string;
  username?: string;
  role: 'owner' | 'member' | 'guest';
  status: 'pending' | 'active' | 'suspended';
  bio: string;
  auth_provider?: string;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
  last_login_at?: string;
  password_hash: string;
}

export interface SharedWwwGateUserStoreOptions {
  db: any;
  userAuth?: any;
  [key: string]: any;
}

export interface SaveUserInput {
  id?: string;
  userId?: string;
  email?: string;
  displayName?: string;
  display_name?: string;
  username?: string;
  role?: 'owner' | 'member' | 'guest';
  status?: 'pending' | 'active' | 'suspended';
  bio?: string;
  authProvider?: string;
  auth_provider?: string;
  passwordHash?: string;
  password_hash?: string;
  isDefault?: boolean;
  lastLoginAt?: string;
  last_login_at?: string;
}

export interface SharedWwwGateUserStore {
  kind: 'shared';
  counts(): { users: number; pendingUsers: number };
  createRequestContext(user: any, options?: any): RequestContext;
  deleteUser(userId: string): { deleted: boolean; userId: string | null };
  markLoginSuccess(userId: string): SharedWwwGateUser | null;
  saveUser(input?: SaveUserInput): SharedWwwGateUser | null;
  userByEmail(email: string): SharedWwwGateUser | null;
  userById(userId: string): SharedWwwGateUser | null;
  users(): SharedWwwGateUser[];
}

function normalizeOptionalString(value: any): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function normalizeEmail(value: any): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function normalizeRole(value: any, fallback: string = 'member'): 'owner' | 'member' | 'guest' {
  return value === 'owner' || value === 'member' || value === 'guest'
    ? value
    : fallback as 'owner' | 'member' | 'guest';
}

export function normalizeStatus(value: any, fallback: string = 'pending'): 'pending' | 'active' | 'suspended' {
  return value === 'pending' || value === 'active' || value === 'suspended'
    ? value
    : fallback as 'pending' | 'active' | 'suspended';
}

function normalizeUserIdCandidate(value: any): string | null {
  const normalized = normalizeOptionalUserId(value);
  if (!normalized) return null;
  return String(normalized)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '') || null;
}

function defaultDisplayName(userId: string, role: any): string {
  if (userId === DEFAULT_USER_ID || role === 'owner') return 'Local User';
  return String(userId || '')
    .split(/[._-]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'User';
}

function deriveBaseUserId(email: string | null, displayName: any): string {
  return normalizeUserIdCandidate(String(email || '').split('@')[0])
    || normalizeUserIdCandidate(displayName)
    || 'user';
}

export function mapSharedUserRow(row: any): SharedWwwGateUser | null {
  if (!row) return null;
  const userId = normalizeUserIdCandidate(row.user_id || row.userId || row.id) || DEFAULT_USER_ID;
  const role = normalizeRole(row.role, userId === DEFAULT_USER_ID ? 'owner' : 'member');
  return {
    ...row,
    id: userId,
    userId,
    email: normalizeEmail(row.email) || '',
    display_name: normalizeOptionalString(row.display_name || row.displayName) || defaultDisplayName(userId, role),
    displayName: normalizeOptionalString(row.display_name || row.displayName) || defaultDisplayName(userId, role),
    username: normalizeOptionalString(row.username) || undefined,
    role,
    status: normalizeStatus(row.status, userId === DEFAULT_USER_ID ? 'active' : 'pending'),
    bio: normalizeOptionalString(row.bio) || '',
    auth_provider: normalizeOptionalString(row.auth_provider || row.authProvider) || undefined,
    is_default: Number(row.is_default || row.isDefault || 0) === 1,
    created_at: normalizeOptionalString(row.created_at || row.createdAt) || undefined,
    updated_at: normalizeOptionalString(row.updated_at || row.updatedAt) || undefined,
    last_login_at: normalizeOptionalString(row.last_login_at || row.lastLoginAt) || undefined,
    password_hash: normalizeOptionalString(row.password_hash) || ''
  };
}

export function createSharedWwwGateUserStore(options: SharedWwwGateUserStoreOptions): SharedWwwGateUserStore {
  const db = options?.db;
  const userAuth = options?.userAuth || null;
  if (!db?.get || !db?.all || !db?.run) {
    throw new Error('shared www-gate user store requires a db with get/all/run methods');
  }

  function getRawUserById(userId: string): any {
    const normalizedUserId = normalizeUserIdCandidate(userId);
    if (!normalizedUserId) return null;
    return db.get('SELECT * FROM users WHERE user_id = ?', [normalizedUserId]) || null;
  }

  function getRawUserByEmail(email: string): any {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    return db.get('SELECT * FROM users WHERE lower(email) = lower(?)', [normalizedEmail]) || null;
  }

  function nextAvailableUserId(baseUserId: string): string {
    const base = normalizeUserIdCandidate(baseUserId) || 'user';
    let candidate = base;
    let suffix = 2;
    while (getRawUserById(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  function counts(): { users: number; pendingUsers: number } {
    return {
      users: Number(db.get('SELECT count(*) AS count FROM users')?.count || 0),
      pendingUsers: Number(db.get("SELECT count(*) AS count FROM users WHERE status = 'pending'")?.count || 0)
    };
  }

  function userByEmail(email: string): SharedWwwGateUser | null {
    return mapSharedUserRow(getRawUserByEmail(email));
  }

  function userById(userId: string): SharedWwwGateUser | null {
    return mapSharedUserRow(getRawUserById(userId));
  }

  function users(): SharedWwwGateUser[] {
    return db.all('SELECT * FROM users ORDER BY is_default DESC, created_at DESC, display_name ASC, user_id ASC')
      .map(mapSharedUserRow)
      .filter(Boolean) as SharedWwwGateUser[];
  }

  function saveUser(input: SaveUserInput = {}): SharedWwwGateUser | null {
    const existing = getRawUserById(input.id || input.userId || '') || getRawUserByEmail(input.email || '') || null;
    const normalizedEmail = normalizeEmail(input.email || existing?.email);
    const displayName = normalizeOptionalString(input.displayName || input.display_name || existing?.display_name)
      || defaultDisplayName(existing?.user_id || deriveBaseUserId(normalizedEmail, input.displayName), input.role || existing?.role);
    const requestedUserId = normalizeUserIdCandidate(input.userId || input.id || existing?.user_id || deriveBaseUserId(normalizedEmail, displayName));
    const userId = existing
      ? (normalizeUserIdCandidate(existing.user_id) || requestedUserId || 'user')
      : nextAvailableUserId(requestedUserId || 'user');
    const role = normalizeRole(input.role || existing?.role, userId === DEFAULT_USER_ID ? 'owner' : 'member');
    const status = normalizeStatus(input.status || existing?.status, userId === DEFAULT_USER_ID ? 'active' : (normalizedEmail ? 'pending' : 'active'));
    const bio = normalizeOptionalString(input.bio || existing?.bio) || '';
    const username = normalizeOptionalString(input.username || existing?.username || (normalizedEmail ? normalizedEmail.split('@')[0] : userId));
    const authProvider = normalizeOptionalString(input.authProvider || input.auth_provider || existing?.auth_provider || (userId === DEFAULT_USER_ID ? 'local-profile' : 'www-gate'));
    const passwordHash = normalizeOptionalString(input.passwordHash || input.password_hash || existing?.password_hash);
    const isDefault = input.isDefault === undefined
      ? Boolean(existing?.is_default || userId === DEFAULT_USER_ID)
      : input.isDefault === true;
    const duplicate = normalizedEmail ? getRawUserByEmail(normalizedEmail) : null;

    if (!displayName || !userId) {
      throw new Error('userId and displayName are required');
    }
    if (duplicate && normalizeUserIdCandidate(duplicate.user_id) !== userId) {
      throw new Error('That email is already registered.');
    }

    db.run(
      `INSERT INTO users (
        user_id, role, username, display_name, auth_provider,
        is_default, email, password_hash, status, bio, last_login_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        role = excluded.role, username = excluded.username, display_name = excluded.display_name,
        auth_provider = excluded.auth_provider,
        is_default = excluded.is_default, email = excluded.email,
        password_hash = COALESCE(excluded.password_hash, users.password_hash),
        status = excluded.status, bio = excluded.bio,
        last_login_at = COALESCE(excluded.last_login_at, users.last_login_at),
        updated_at = CURRENT_TIMESTAMP`,
      [
        userId, role, username, displayName, authProvider,
        isDefault ? 1 : 0, normalizedEmail, passwordHash, status, bio,
        normalizeOptionalString(input.lastLoginAt || input.last_login_at || existing?.last_login_at)
      ]
    );

    return userById(userId);
  }

  function deleteUser(userId: string): { deleted: boolean; userId: string | null } {
    const normalizedUserId = normalizeUserIdCandidate(userId);
    if (!normalizedUserId || normalizedUserId === DEFAULT_USER_ID) {
      return { deleted: false, userId: normalizedUserId || null };
    }
    db.run("UPDATE users SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?", [normalizedUserId]);
    return { deleted: true, userId: normalizedUserId };
  }

  function createRequestContext(user: any, options = {}): RequestContext {
    if (userAuth?.createWwwGateRequestContext) {
      return userAuth.createWwwGateRequestContext(user, options);
    }
    return {
      source: 'www-gate',
      userId: normalizeOptionalString(user?.userId || user?.id || options.userId) || undefined,
      sessionId: normalizeOptionalString(options.sessionId) || undefined,
      requestId: normalizeOptionalString(options.requestId) || undefined
    };
  }

  function markLoginSuccess(userId: string): SharedWwwGateUser | null {
    const normalizedUserId = normalizeUserIdCandidate(userId);
    if (!normalizedUserId) return null;
    db.run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [normalizedUserId]);
    return userById(normalizedUserId);
  }

  return {
    kind: 'shared',
    counts,
    createRequestContext,
    deleteUser,
    markLoginSuccess,
    saveUser,
    userByEmail,
    userById,
    users
  };
}
