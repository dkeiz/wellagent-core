// @ts-nocheck
import fs = require('fs');
import path = require('path');
const crypto = require('crypto');
const { DEFAULT_USER_ID, LEGACY_DEFAULT_USER_ID } = require('./user-scope');

function optional(value: any): string | null {
  return String(value || '').trim() || null;
}

function normalizeAccountId(value: any): string | null {
  const normalized = optional(value);
  if (!normalized) return null;
  const slug = normalized.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return !slug || slug === DEFAULT_USER_ID || slug === LEGACY_DEFAULT_USER_ID ? null : slug;
}

function deriveUserId(input: any = {}): string | null {
  return normalizeAccountId(input.userId)
    || normalizeAccountId(input.username)
    || normalizeAccountId(String(input.email || '').split('@')[0])
    || normalizeAccountId(input.displayName);
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch (_error) {
    return false;
  }
}

function buildVisibleUsers(db: any, userRegistry: any): any[] {
  const rows = db.all('SELECT user_id, password_hash FROM users');
  const passwords = new Map(rows.map((row: any) => [String(row.user_id), Boolean(String(row.password_hash || '').trim())]));
  return userRegistry.listUsers()
    .filter((user: any) => user.userId === DEFAULT_USER_ID || user.status !== 'suspended')
    .map((user: any) => ({ ...user, hasPassword: passwords.get(user.userId) === true }));
}

function findUser(db: any, identifier: string): any | null {
  return db.get(
    `SELECT * FROM users
     WHERE lower(user_id) = lower(?) OR lower(username) = lower(?) OR lower(email) = lower(?)
     ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
    [identifier, identifier, identifier]
  ) || null;
}

export function createDesktopAccountService(runtime: any = {}) {
  const db = runtime.db;
  const userRegistry = runtime.userRegistry;
  const userAuth = runtime.userAuth;
  const agentManager = runtime.agentManager;
  const profileRegistry = runtime.profileRegistry || null;
  const agentinRoot = String(runtime.runtimePaths?.agentinRoot || '').trim();

  if (!db?.run || !db?.get || !db?.all || !db?.db?.exec) throw new Error('Desktop account service requires the shared database');
  if (!userRegistry?.getUser || !userRegistry?.listUsers) throw new Error('Desktop account service requires user registry');
  if (!userAuth?.getActiveUser || !userAuth?.setActiveUser) throw new Error('Desktop account service requires mutable user auth');
  if (!agentManager?.initializeUser) throw new Error('Desktop account service requires AgentManager.initializeUser');
  if (!agentinRoot) throw new Error('Desktop account service requires agentinRoot');

  function activeUser() {
    return userAuth.getActiveUser();
  }

  function getState() {
    const current = activeUser();
    return {
      success: true,
      activeProfile: profileRegistry?.getProfile?.(current.userId) || null,
      activeUser: current,
      activeUserId: current.userId,
      canCloneLocalData: current.userId === DEFAULT_USER_ID,
      users: buildVisibleUsers(db, userRegistry).map((user) => ({ ...user, isActive: user.userId === current.userId }))
    };
  }

  function saveDesktopUser(user: any): any {
    db.run(
      `INSERT INTO users (
        user_id, role, username, display_name, auth_provider, is_default,
        email, password_hash, status, bio, last_login_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        role = excluded.role, username = excluded.username, display_name = excluded.display_name,
        auth_provider = excluded.auth_provider, email = excluded.email,
        password_hash = excluded.password_hash, status = 'active', updated_at = CURRENT_TIMESTAMP`,
      [user.userId, 'member', user.username, user.displayName, 'local-password', user.email, user.passwordHash]
    );
    return userRegistry.getUser(user.userId);
  }

  function activate(userId: string) {
    const user = userRegistry.getUser(userId);
    if (!user || user.status === 'suspended') throw new Error(`User not found: ${userId}`);
    db.run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [user.userId]);
    userAuth.setActiveUser(user);
    return user;
  }

  async function register(input: any = {}) {
    const cloneLocalData = input.mode === 'clone-localuser' || input.cloneLocalData === true;
    const password = optional(input.password);
    if (!password || password.length < 4) throw new Error('Password is required');
    const userId = deriveUserId(input);
    if (!userId) throw new Error('User ID is required');
    if (userRegistry.getUser(userId)) throw new Error('That account already exists');
    if (cloneLocalData && activeUser().userId !== DEFAULT_USER_ID) {
      throw new Error('Local User data can only be imported while Local User is active');
    }

    const userRoot = path.join(agentinRoot, 'users', userId);
    const folderExisted = fs.existsSync(userRoot);
    let transactionOpen = false;
    try {
      db.db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const saved = saveDesktopUser({
        userId,
        username: optional(input.username) || userId,
        displayName: optional(input.displayName) || userId,
        email: optional(input.email),
        passwordHash: hashPassword(password)
      });
      await agentManager.initializeUser(userId, cloneLocalData ? DEFAULT_USER_ID : null);
      db.db.exec('COMMIT');
      transactionOpen = false;
      const user = activate(saved.userId);
      return {
        ...getState(),
        user,
        profile: profileRegistry?.getProfile?.(user.userId) || null,
        requiresRestart: false,
        restartOptions: null
      };
    } catch (error) {
      if (transactionOpen) {
        try { db.db.exec('ROLLBACK'); } catch (_rollbackError) {}
      }
      if (!folderExisted && fs.existsSync(userRoot)) fs.rmSync(userRoot, { recursive: true, force: true });
      throw error;
    }
  }

  function login(input: any = {}) {
    const identifier = optional(input.identifier || input.userId || input.username || input.email);
    const password = optional(input.password);
    if (!identifier || !password) throw new Error('Identifier and password are required');
    const row = findUser(db, identifier);
    if (!row) throw new Error('Account not found');
    if (String(row.status || 'active') === 'suspended') throw new Error('This account is suspended');
    if (!verifyPassword(password, String(row.password_hash || ''))) throw new Error('Invalid password');
    const user = activate(String(row.user_id));
    return { ...getState(), user, profile: profileRegistry?.getProfile?.(user.userId) || null, requiresRestart: false, restartOptions: null };
  }

  function switchUser(input: any = {}) {
    const userId = optional(typeof input === 'string' ? input : input.userId) || DEFAULT_USER_ID;
    const user = activate(userId);
    return { ...getState(), user, profile: profileRegistry?.getProfile?.(user.userId) || null, requiresRestart: false, restartOptions: null };
  }

  return { getState, login, register, switchUser, switchToLocalUser: () => switchUser(DEFAULT_USER_ID) };
}
