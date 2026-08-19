import path = require('path');
import type { LocalProfile } from '../../shared/types';
const { DEFAULT_USER_ID, normalizeUserId } = require('./user-scope');

export const DEFAULT_PROFILE_ID = DEFAULT_USER_ID;
export const LEGACY_DEFAULT_PROFILE_ID = 'owner';
export const PROFILE_REGISTRY_FILE = 'profiles/registry.json';

export interface ProfileOverrides {
  createdAt?: string;
  displayName?: string;
  isDefault?: boolean;
  lastUsedAt?: string;
  status?: 'active' | 'archived';
  archivedAt?: string | null;
}

export interface ProfileRegistryOptions {
  [key: string]: any;
  agentinRoot?: string;
  db?: any;
  dbPath?: string;
  userDataPath?: string | null;
  userRegistry?: any;
  activeUserId?: string | null;
}

export interface ProfileRegistry {
  deleteProfile: (userId: string) => LocalProfile | null;
  ensureProfile: (userId: string, overrides?: ProfileOverrides) => LocalProfile;
  getActiveNamedProfile: () => LocalProfile | null;
  getActiveProfile: () => LocalProfile;
  getActiveProfileId: () => string;
  getProfile: (userId: string) => LocalProfile | null;
  getProfilesRoot: () => string;
  getRegistryPath: () => string;
  getUserDataPath: () => string;
  listProfiles: () => LocalProfile[];
  setActiveProfile: (userId: string, overrides?: ProfileOverrides) => LocalProfile;
}

function normalizeProfileUserId(value: any): string {
  const raw = String(value || '').trim().toLowerCase();
  return normalizeUserId(raw === LEGACY_DEFAULT_PROFILE_ID ? DEFAULT_USER_ID : raw, DEFAULT_USER_ID);
}

function defaultDisplayName(userId: string): string {
  if (userId === DEFAULT_USER_ID) return 'Local User';
  return userId.split(/[._-]/g).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') || 'User';
}

export function createProfileRegistry(options: ProfileRegistryOptions = {}): ProfileRegistry {
  const db = options.db;
  if (!db?.get || !db?.all || !db?.run) {
    throw new Error('Profile registry requires the shared database');
  }
  const agentinRoot = path.resolve(String(options.agentinRoot || path.join(process.cwd(), 'agentin')));
  const usersRoot = path.join(agentinRoot, 'users');
  const userDataPath = String(options.userDataPath || '');
  const userRegistry = options.userRegistry || null;
  let activeUserId = normalizeProfileUserId(
    options.activeUserId
    || db.get("SELECT value FROM settings WHERE key = 'desktop.activeUserId'")?.value
    || DEFAULT_USER_ID
  );

  function mapRow(row: any): LocalProfile | null {
    if (!row) return null;
    const userId = normalizeProfileUserId(row.user_id || row.userId);
    return {
      userId,
      displayName: String(row.display_name || row.displayName || defaultDisplayName(userId)),
      userRoot: userId === DEFAULT_USER_ID ? agentinRoot : path.join(usersRoot, userId),
      isDefault: userId === DEFAULT_USER_ID,
      status: String(row.status || '') === 'suspended' ? 'archived' : 'active',
      createdAt: row.created_at || row.createdAt || undefined,
      lastUsedAt: row.last_login_at || row.lastUsedAt || undefined,
      archivedAt: String(row.status || '') === 'suspended' ? (row.updated_at || new Date().toISOString()) : null
    };
  }

  function ensureProfile(userId: string, overrides: ProfileOverrides = {}): LocalProfile {
    const normalizedUserId = normalizeProfileUserId(userId);
    let user = userRegistry?.getUser?.(normalizedUserId) || null;
    if (!user) {
      user = userRegistry?.ensureUser?.(normalizedUserId, {
        displayName: overrides.displayName || defaultDisplayName(normalizedUserId),
        isDefault: normalizedUserId === DEFAULT_USER_ID,
        role: normalizedUserId === DEFAULT_USER_ID ? 'owner' : 'member',
        status: overrides.status === 'archived' ? 'suspended' : 'active',
        username: normalizedUserId
      });
    }
    if (!user) {
      throw new Error(`User not found: ${normalizedUserId}`);
    }
    return mapRow({
      ...user,
      user_id: user.userId,
      display_name: overrides.displayName || user.displayName,
      status: overrides.status === 'archived' ? 'suspended' : user.status
    }) as LocalProfile;
  }

  function getProfile(userId: string): LocalProfile | null {
    const normalizedUserId = normalizeProfileUserId(userId);
    return mapRow(db.get('SELECT * FROM users WHERE user_id = ?', [normalizedUserId]));
  }

  function getActiveProfile(): LocalProfile {
    const current = getProfile(activeUserId);
    if (current && current.status !== 'archived') return current;
    activeUserId = DEFAULT_USER_ID;
    return ensureProfile(DEFAULT_USER_ID);
  }

  function setActiveProfile(userId: string, overrides: ProfileOverrides = {}): LocalProfile {
    const profile = ensureProfile(userId, overrides);
    if (profile.status === 'archived') throw new Error(`User is archived: ${profile.userId}`);
    activeUserId = profile.userId;
    db.run(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('desktop.activeUserId', ?, CURRENT_TIMESTAMP)",
      [activeUserId]
    );
    return profile;
  }

  function deleteProfile(userId: string): LocalProfile | null {
    const normalizedUserId = normalizeProfileUserId(userId);
    if (normalizedUserId === DEFAULT_USER_ID) return null;
    const existing = getProfile(normalizedUserId);
    if (!existing) return null;
    db.run("UPDATE users SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?", [normalizedUserId]);
    if (activeUserId === normalizedUserId) setActiveProfile(DEFAULT_USER_ID);
    return getProfile(normalizedUserId);
  }

  return {
    deleteProfile,
    ensureProfile,
    getActiveNamedProfile() {
      const active = getActiveProfile();
      return active.userId === DEFAULT_USER_ID ? null : active;
    },
    getActiveProfile,
    getActiveProfileId() {
      return getActiveProfile().userId;
    },
    getProfile,
    getProfilesRoot() {
      return usersRoot;
    },
    getRegistryPath() {
      return '';
    },
    getUserDataPath() {
      return userDataPath;
    },
    listProfiles() {
      return db.all("SELECT * FROM users WHERE user_id <> ? AND status <> 'suspended' ORDER BY display_name, user_id", [DEFAULT_USER_ID])
        .map(mapRow).filter(Boolean);
    },
    setActiveProfile
  };
}
