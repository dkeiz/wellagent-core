// @ts-nocheck
import fs = require('fs');
import path = require('path');
const crypto = require('crypto');
const Sqlite = require('better-sqlite3');

const USER_TABLES = [
  'agents', 'chat_sessions', 'conversations', 'subagent_runs', 'calendar_events',
  'todos', 'api_keys', 'prompt_rules', 'workflows', 'memory_jobs',
  'daemon_session_inspections', 'tool_calls'
];
const TEMPORARY_PARTS = new Set(['sessions', 'temp', 'workspaces', 'subtasks']);

function tableExists(db: any, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columns(db: any, table: string): string[] {
  return tableExists(db, table) ? db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row: any) => row.name) : [];
}

function sourceKey(filePath: string): string {
  return crypto.createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex');
}

function safeUserFolder(userId: string): string {
  return String(userId || 'localuser').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'localuser';
}

function ensureTrackingTable(db: any): void {
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_appdata_imports (
    source_key TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    users_json TEXT,
    status TEXT NOT NULL DEFAULT 'database-imported',
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  )`);
  const names = new Set(db.prepare('PRAGMA table_info(legacy_appdata_imports)').all().map((row: any) => row.name));
  if (!names.has('status')) db.exec("ALTER TABLE legacy_appdata_imports ADD COLUMN status TEXT NOT NULL DEFAULT 'database-imported'");
  if (!names.has('completed_at')) db.exec('ALTER TABLE legacy_appdata_imports ADD COLUMN completed_at DATETIME');
}

function insertRow(target: any, table: string, row: any, options: any = {}): any {
  const targetColumns = new Set(columns(target, table));
  const copy = Object.fromEntries(Object.entries(row).filter(([key]) => targetColumns.has(key) && key !== 'profile_id'));
  if (options.userId && targetColumns.has('user_id')) copy.user_id = options.userId;
  if (options.agentMap && copy.agent_id != null) copy.agent_id = options.agentMap.get(String(copy.agent_id)) ?? copy.agent_id;
  if (options.agentMap && copy.subagent_id != null) copy.subagent_id = options.agentMap.get(String(copy.subagent_id)) ?? copy.subagent_id;
  if (options.sessionMap && copy.session_id != null) copy.session_id = options.sessionMap.get(String(copy.session_id)) ?? copy.session_id;
  if (options.sessionMap && copy.parent_session_id != null) copy.parent_session_id = options.sessionMap.get(String(copy.parent_session_id)) ?? copy.parent_session_id;
  if (options.sessionMap && copy.child_session_id != null) copy.child_session_id = options.sessionMap.get(String(copy.child_session_id)) ?? copy.child_session_id;

  const originalId = copy.id;
  const execute = () => {
    const keys = Object.keys(copy);
    const placeholders = keys.map(() => '?').join(', ');
    const result = target.prepare(`INSERT INTO ${table} (${keys.map(key => `"${key}"`).join(', ')}) VALUES (${placeholders})`).run(...keys.map(key => copy[key]));
    return copy.id ?? result.lastInsertRowid;
  };

  try {
    return execute();
  } catch (_) {
    delete copy.id;
    if (table === 'agents') copy.name = `${copy.name || 'Agent'} (imported ${String(originalId || '').slice(-6) || 'copy'})`;
    if (table === 'api_keys') copy.provider = `${copy.provider || 'provider'}-imported-${String(originalId || Date.now()).slice(-6)}`;
    if (table === 'tool_calls') copy.tool_call_id = `${copy.tool_call_id || 'call'}-imported-${crypto.randomBytes(3).toString('hex')}`;
    if (table === 'daemon_session_inspections') copy.session_id = `${copy.session_id || 'session'}-imported-${crypto.randomBytes(3).toString('hex')}`;
    try { return execute(); } catch (_) { return null; }
  }
}

function rowsForUser(source: any, table: string, userId: string): any[] {
  if (!tableExists(source, table) || !columns(source, table).includes('user_id')) return [];
  return source.prepare(`SELECT * FROM ${table} WHERE COALESCE(user_id, 'localuser') = ?`).all(userId);
}

function importUserRows(target: any, source: any, userId: string, targetUserRoot: string): void {
  const sourceUser = tableExists(source, 'users') ? source.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) : null;
  if (sourceUser) {
    const user = { ...sourceUser };
    delete user.profile_id;
    const keys = Object.keys(user).filter(key => columns(target, 'users').includes(key));
    target.prepare(`INSERT OR IGNORE INTO users (${keys.map(key => `"${key}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map(key => user[key]));
  }

  const agentMap = new Map();
  for (const sourceRow of rowsForUser(source, 'agents', userId)) {
    const row = { ...sourceRow };
    if (targetUserRoot && row.folder_path) {
      row.folder_path = path.join(targetUserRoot, 'agents', path.basename(String(row.folder_path)));
    }
    const nextId = insertRow(target, 'agents', row, { userId });
    if (nextId != null) agentMap.set(String(row.id), nextId);
  }
  const sessionMap = new Map();
  for (const row of rowsForUser(source, 'chat_sessions', userId)) {
    const nextId = insertRow(target, 'chat_sessions', row, { userId, agentMap });
    if (nextId != null) sessionMap.set(String(row.id), nextId);
  }
  for (const table of USER_TABLES.filter(name => !['agents', 'chat_sessions'].includes(name))) {
    for (const row of rowsForUser(source, table, userId)) {
      insertRow(target, table, row, { userId, agentMap, sessionMap });
    }
  }
}

function sameFile(left: string, right: string): boolean {
  try { return fs.realpathSync(left).toLowerCase() === fs.realpathSync(right).toLowerCase(); } catch (_) { return false; }
}

function discoverDatabases(userDataPath: string, targetDbPath: string): string[] {
  if (!userDataPath || !fs.existsSync(userDataPath)) return [];
  const candidates = [path.join(userDataPath, 'localagent.db')];
  const profilesRoot = path.join(userDataPath, 'profiles');
  if (fs.existsSync(profilesRoot)) {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(profilesRoot, entry.name, 'localagent.db'));
    }
  }
  return candidates.filter(candidate => fs.existsSync(candidate) && !sameFile(candidate, targetDbPath));
}

function copyPersistentTree(sourceRoot: string, targetRoot: string): void {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return;
  const visit = (sourceDir: string, targetDir: string) => {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (TEMPORARY_PARTS.has(entry.name.toLowerCase())) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        visit(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) continue;
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
        continue;
      }
      const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
      const targetHash = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
      if (sourceHash === targetHash) continue;
      const extension = path.extname(targetPath);
      const preservedPath = `${targetPath.slice(0, extension ? -extension.length : undefined)}.imported-${sourceHash.slice(0, 8)}${extension}`;
      if (!fs.existsSync(preservedPath)) fs.copyFileSync(sourcePath, preservedPath);
    }
  };
  visit(sourceRoot, targetRoot);
}

function sourceUsers(source: any, dbPath: string): string[] {
  if (!tableExists(source, 'users')) return [];
  const users = source.prepare('SELECT user_id FROM users').all().map((row: any) => String(row.user_id || '').trim()).filter(Boolean);
  const folderUser = path.basename(path.dirname(dbPath));
  if (path.basename(path.dirname(path.dirname(dbPath))).toLowerCase() === 'profiles' && users.includes(folderUser)) return [folderUser];
  return users;
}

export function runLegacyAppDataMigration(options: any = {}) {
  const target = options.db?.db;
  const targetDbPath = options.db?.dbPath;
  const agentinRoot = options.agentinRoot;
  if (!target || !targetDbPath || !agentinRoot) return { imported: [], skipped: [] };
  ensureTrackingTable(target);
  const result = { imported: [], skipped: [] };

  for (const dbPath of discoverDatabases(String(options.userDataPath || ''), targetDbPath)) {
    const key = sourceKey(dbPath);
    const tracked = target.prepare('SELECT * FROM legacy_appdata_imports WHERE source_key = ?').get(key);
    if (tracked?.status === 'complete') {
      result.skipped.push(dbPath);
      continue;
    }
    const source = new Sqlite(dbPath, { readonly: true, fileMustExist: true });
    try {
      const users = tracked?.users_json ? JSON.parse(tracked.users_json) : sourceUsers(source, dbPath);
      if (!tracked) {
        target.transaction(() => {
          for (const userId of users) {
            const targetRoot = userId === 'localuser' ? agentinRoot : path.join(agentinRoot, 'users', safeUserFolder(userId));
            importUserRows(target, source, userId, targetRoot);
          }
          target.prepare(`INSERT INTO legacy_appdata_imports
            (source_key, source_path, users_json, status) VALUES (?, ?, ?, 'database-imported')`)
            .run(key, dbPath, JSON.stringify(users));
        })();
      }
      const profileDir = path.dirname(dbPath);
      const sourceAgentin = fs.existsSync(path.join(profileDir, 'agentin')) ? path.join(profileDir, 'agentin') : null;
      if (sourceAgentin) {
        const durableFolders = ['agents', 'memory', 'tasks', 'outputs', 'research', 'userabout'];
        for (const userId of users) {
          const targetRoot = userId === 'localuser' ? agentinRoot : path.join(agentinRoot, 'users', safeUserFolder(userId));
          for (const folder of durableFolders) {
            copyPersistentTree(path.join(sourceAgentin, folder), path.join(targetRoot, folder));
          }
        }
      }
      target.prepare("UPDATE legacy_appdata_imports SET status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE source_key = ?").run(key);
      result.imported.push({ dbPath, users });
    } finally {
      source.close();
    }
  }
  return result;
}
