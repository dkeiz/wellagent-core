// @ts-nocheck
import type { RequestContext } from '../../shared/types';

const { DEFAULT_USER_ID, isBuiltInUserId, normalizeUserId, requireUserScope } = require('./user-scope');

export const DEFAULT_RUNTIME_USER_ID = DEFAULT_USER_ID;

export interface ChatOwnershipScope {
  concurrent: boolean;
  persistCurrent: boolean;
  requestContext: RequestContext | Record<string, any>;
  userId: string;
}

export interface ChatOwnershipOptions {
  requestContext?: RequestContext | Record<string, any>;
  userId?: string;
  user_id?: string;
  persistCurrent?: boolean;
  makeCurrent?: boolean;
  includeHidden?: boolean;
  [key: string]: any;
}

export interface ChatSessionRow {
  id: number | bigint;
  title?: string;
  agent_id?: number | null;
  user_id?: string;
  created_at?: string;
  last_message_at?: string;
  message_count?: number;
  first_message?: string;
}

function normalizeScopeUserId(value: any, fallback: string = DEFAULT_RUNTIME_USER_ID): string {
  return normalizeUserId(value, fallback);
}

function getLegacyScopedSettingKey(key: string, userId: string): string {
  return isBuiltInUserId(userId) ? key : `${key}.${userId}`;
}

function normalizeStoredSessionId(sessionId: string | number | null | undefined): string {
  return String(sessionId ?? '').trim();
}

function listSessionIdLookupValues(sessionId: string | number | null | undefined): string[] {
  const normalized = normalizeStoredSessionId(sessionId);
  if (!normalized) return [];
  const values = [normalized];
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    values.push(String(numeric));
    if (Number.isInteger(numeric)) {
      values.push(numeric.toFixed(1));
    }
  }
  return [...new Set(values.filter(Boolean))];
}

function buildSessionIdWhereClause(columnName: string, sessionId: string | number | null | undefined): { clause: string; params: string[] } {
  const values = listSessionIdLookupValues(sessionId);
  if (values.length === 0) {
    return { clause: `${columnName} = ?`, params: [''] };
  }
  return {
    clause: `${columnName} IN (${values.map(() => '?').join(', ')})`,
    params: values
  };
}

async function getScopedCurrentSessionId(store: any, scope: ChatOwnershipScope): Promise<string | null> {
  if (store?.getScopedSetting) {
    return await store.getScopedSetting('current_session_id', scope);
  }
  if (store?.getSetting) {
    return await store.getSetting(getLegacyScopedSettingKey('current_session_id', scope.userId));
  }
  return null;
}

async function setScopedCurrentSessionId(store: any, scope: ChatOwnershipScope, sessionId: string): Promise<void> {
  if (store?.saveScopedSetting) {
    await store.saveScopedSetting('current_session_id', sessionId, scope);
    return;
  }
  if (store?.setSetting) {
    await store.setSetting(getLegacyScopedSettingKey('current_session_id', scope.userId), sessionId);
  }
}

async function clearScopedCurrentSessionId(store: any, scope: ChatOwnershipScope): Promise<void> {
  if (store?.deleteScopedSetting) {
    await store.deleteScopedSetting('current_session_id', scope);
    return;
  }
  if (store?.run) {
    store.run('DELETE FROM settings WHERE key = ?', [getLegacyScopedSettingKey('current_session_id', scope.userId)]);
  }
}

async function clearScopedRuntimeSessionState(store: any, scope: ChatOwnershipScope, sessionId: string | number): Promise<void> {
  const normalizedSessionId = normalizeStoredSessionId(sessionId);
  if (!normalizedSessionId) return;
  const keys = [
    `session.runtime.${normalizedSessionId}`,
    `session.runtime.opencode.${normalizedSessionId}`
  ];
  if (store?.deleteScopedSetting) {
    for (const key of keys) {
      await store.deleteScopedSetting(key, scope);
    }
    return;
  }
  if (store?.saveScopedSetting) {
    for (const key of keys) {
      await store.saveScopedSetting(key, '', scope);
    }
  }
}

export function resolveScope(options: ChatOwnershipOptions = {}): ChatOwnershipScope {
  const input = options && typeof options === 'object' ? options : {} as ChatOwnershipOptions;
  const scope = requireUserScope(input, require('./request-context'));
  return {
    ...scope,
    persistCurrent: input.persistCurrent !== false && !scope.concurrent
  };
}

function mapSessionRow(row: any, fallbackUserId: string = DEFAULT_RUNTIME_USER_ID): ChatSessionRow | null {
  return row ? { ...row, user_id: normalizeScopeUserId(row.user_id, fallbackUserId) } : null;
}

export async function getChatSessionById(store: any, sessionId: string | number, options: ChatOwnershipOptions = {}): Promise<ChatSessionRow | null> {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const scope = resolveScope(options);
  return mapSessionRow(
    store.get(
      'SELECT * FROM chat_sessions WHERE id = ? AND COALESCE(user_id, ?) = ?',
      [sid, DEFAULT_RUNTIME_USER_ID, scope.userId]
    ),
    scope.userId
  );
}

export async function createChatSession(store: any, title: string | null = null, options: ChatOwnershipOptions = {}): Promise<ChatSessionRow> {
  const scope = resolveScope(options);
  const sessionTitle = title || `Chat ${new Date().toLocaleString()}`;
  const shouldMakeCurrent = options?.makeCurrent !== false && scope.persistCurrent;
  const result = store.run('INSERT INTO chat_sessions (title, user_id) VALUES (?, ?)', [sessionTitle, scope.userId]);
  if (shouldMakeCurrent) {
    await setScopedCurrentSessionId(store, scope, String(result.id));
    console.log('Created and switched to new session:', result.id);
  } else {
    console.log('Created new session without switching current session:', result.id);
  }
  return { id: result.id, title: sessionTitle, user_id: scope.userId };
}

export async function getCurrentSession(store: any, options: ChatOwnershipOptions = {}): Promise<ChatSessionRow> {
  const scope = resolveScope(options);
  const currentId = await getScopedCurrentSessionId(store, scope);
  if (currentId) {
    const session = await getChatSessionById(store, currentId, scope);
    if (session) {
      console.log('Found current session:', session.id);
      return session;
    }
  }
  const session = store.get(
    `SELECT cs.* FROM chat_sessions cs
     INNER JOIN conversations c ON cs.id = c.session_id AND COALESCE(c.user_id, ?) = ?
     WHERE cs.agent_id IS NULL AND COALESCE(cs.user_id, ?) = ?
     GROUP BY cs.id
     ORDER BY cs.last_message_at DESC
     LIMIT 1`,
    [DEFAULT_RUNTIME_USER_ID, scope.userId, DEFAULT_RUNTIME_USER_ID, scope.userId]
  );
  if (!session) {
    console.log('No sessions found, creating new one');
    return createChatSession(store, null, { ...options, userId: scope.userId, requestContext: scope.requestContext, makeCurrent: scope.persistCurrent });
  }
  console.log('Using most recent session:', session.id);
  if (scope.persistCurrent) {
    await setScopedCurrentSessionId(store, scope, String(session.id));
  }
  return mapSessionRow(session, scope.userId)!;
}

export async function setCurrentSession(store: any, sessionId: string | number, options: ChatOwnershipOptions = {}): Promise<{ sessionId: number | bigint }> {
  const sid = String(sessionId || '').trim();
  if (!sid) throw new Error('sessionId is required');
  const session = await getChatSessionById(store, sid, options);
  if (!session) throw new Error(`Chat session not found: ${sid}`);
  const scope = resolveScope(options);
  if (scope.persistCurrent) {
    await setScopedCurrentSessionId(store, scope, String(session.id));
  }
  return { sessionId: session.id };
}

export async function getConversations(store: any, limit: number = 100, sessionId: string | null = null, options: ChatOwnershipOptions = {}): Promise<any[]> {
  const scope = resolveScope(options);
  const normalizedLimit = Math.max(1, parseInt(String(limit), 10) || 100);
  const session = sessionId
    ? await getChatSessionById(store, sessionId, scope)
    : await getCurrentSession(store, options);
  if (!session?.id) {
    console.log('No current session found');
    return [];
  }
  const sessionMatch = buildSessionIdWhereClause('session_id', session.id);
  return store.all(
    `SELECT * FROM (
       SELECT * FROM conversations
       WHERE ${sessionMatch.clause} AND COALESCE(user_id, ?) = ?
       ORDER BY id DESC
       LIMIT ?
     ) ORDER BY id ASC`,
    [...sessionMatch.params, DEFAULT_RUNTIME_USER_ID, scope.userId, normalizedLimit]
  ).map((row: any) => store._mapConversationRow(row));
}

export async function addConversation(store: any, message: any, sessionId: string | null = null, options: ChatOwnershipOptions = {}): Promise<any> {
  const scope = resolveScope(options);
  const { role, content, metadata } = message;
  const session = sessionId
    ? await getChatSessionById(store, sessionId, scope)
    : await getCurrentSession(store, options);
  if (!session?.id) {
    throw new Error('No current session found');
  }
  const storedSessionId = normalizeStoredSessionId(session.id);
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  const now = new Date().toISOString();
  store.run(
    'INSERT INTO conversations (session_id, user_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    [storedSessionId, scope.userId, role, content, metaStr, now]
  );
  store.run(
    'UPDATE chat_sessions SET last_message_at = ? WHERE id = ? AND COALESCE(user_id, ?) = ?',
    [now, session.id, DEFAULT_RUNTIME_USER_ID, scope.userId]
  );
  return { ...message, session_id: storedSessionId, user_id: scope.userId, timestamp: now };
}

export async function clearChatSession(store: any, sessionId: string | number, options: ChatOwnershipOptions = {}): Promise<{ cleared: boolean; sessionId: number | bigint }> {
  const scope = resolveScope(options);
  const session = await getChatSessionById(store, sessionId, scope);
  if (!session) throw new Error(`Chat session not found: ${String(sessionId || '').trim()}`);
  const sessionMatch = buildSessionIdWhereClause('session_id', session.id);
  store.run(
    `DELETE FROM conversations WHERE ${sessionMatch.clause} AND COALESCE(user_id, ?) = ?`,
    [...sessionMatch.params, DEFAULT_RUNTIME_USER_ID, scope.userId]
  );
  store.run(
    'UPDATE chat_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(user_id, ?) = ?',
    [session.id, DEFAULT_RUNTIME_USER_ID, scope.userId]
  );
  await clearScopedRuntimeSessionState(store, scope, session.id);
  return { cleared: true, sessionId: session.id };
}

export async function deleteAllConversations(store: any, options: ChatOwnershipOptions = {}): Promise<{ deleted: boolean; message: string }> {
  const scope = resolveScope(options);
  const sessions = store.all(
    'SELECT id FROM chat_sessions WHERE COALESCE(user_id, ?) = ?',
    [DEFAULT_RUNTIME_USER_ID, scope.userId]
  );
  store.run('DELETE FROM conversations WHERE COALESCE(user_id, ?) = ?', [DEFAULT_RUNTIME_USER_ID, scope.userId]);
  store.run('DELETE FROM chat_sessions WHERE COALESCE(user_id, ?) = ?', [DEFAULT_RUNTIME_USER_ID, scope.userId]);
  for (const session of sessions) {
    await clearScopedRuntimeSessionState(store, scope, session.id);
  }
  if (scope.persistCurrent) {
    await clearScopedCurrentSessionId(store, scope);
  }
  console.log('All conversations deleted for privacy');
  return { deleted: true, message: 'All conversation history cleared' };
}

export async function getChatSessions(store: any, date: string | null = null, limit: number = 6, options: ChatOwnershipOptions = {}): Promise<ChatSessionRow[]> {
  const scope = resolveScope(options);
  if (date) {
    return store.all(
      `SELECT cs.*,
              COUNT(c.id) as message_count,
              (SELECT content FROM conversations WHERE session_id = cs.id AND role = 'user' AND COALESCE(user_id, ?) = ? ORDER BY timestamp LIMIT 1) as first_message
       FROM chat_sessions cs
       LEFT JOIN conversations c ON cs.id = c.session_id AND COALESCE(c.user_id, ?) = ?
       WHERE DATE(cs.created_at) = DATE(?) AND cs.agent_id IS NULL AND COALESCE(cs.user_id, ?) = ?
       GROUP BY cs.id
       HAVING message_count > 0
       ORDER BY cs.last_message_at DESC`,
      [DEFAULT_RUNTIME_USER_ID, scope.userId, DEFAULT_RUNTIME_USER_ID, scope.userId, date, DEFAULT_RUNTIME_USER_ID, scope.userId]
    );
  }
  return store.all(
    `SELECT cs.*,
            COUNT(c.id) as message_count,
            (SELECT content FROM conversations WHERE session_id = cs.id AND role = 'user' AND COALESCE(user_id, ?) = ? ORDER BY timestamp LIMIT 1) as first_message
     FROM chat_sessions cs
     LEFT JOIN conversations c ON cs.id = c.session_id AND COALESCE(c.user_id, ?) = ?
     WHERE cs.agent_id IS NULL AND COALESCE(cs.user_id, ?) = ?
     GROUP BY cs.id
     HAVING message_count > 0
     ORDER BY cs.last_message_at DESC
     LIMIT ?`,
    [DEFAULT_RUNTIME_USER_ID, scope.userId, DEFAULT_RUNTIME_USER_ID, scope.userId, DEFAULT_RUNTIME_USER_ID, scope.userId, limit]
  );
}

export async function loadChatSession(store: any, sessionId: string | number, options: ChatOwnershipOptions = {}): Promise<any[]> {
  const scope = resolveScope(options);
  const sessionMatch = buildSessionIdWhereClause('session_id', sessionId);
  const rows = store.all(
    `SELECT * FROM conversations WHERE ${sessionMatch.clause} AND COALESCE(user_id, ?) = ? ORDER BY id`,
    [...sessionMatch.params, DEFAULT_RUNTIME_USER_ID, scope.userId]
  ).map((row: any) => store._mapConversationRow(row));
  if (options?.includeHidden === true) {
    return rows;
  }
  return rows.filter((row: any) => !row?.metadata || row.metadata?.hidden_from_ui !== true);
}

export async function deleteChatSession(store: any, sessionId: string | number, options: ChatOwnershipOptions = {}): Promise<{ success: boolean }> {
  const scope = resolveScope(options);
  const session = await getChatSessionById(store, sessionId, scope);
  if (!session) throw new Error(`Chat session not found: ${String(sessionId || '').trim()}`);
  const sessionMatch = buildSessionIdWhereClause('session_id', session.id);
  store.run(
    `DELETE FROM conversations WHERE ${sessionMatch.clause} AND COALESCE(user_id, ?) = ?`,
    [...sessionMatch.params, DEFAULT_RUNTIME_USER_ID, scope.userId]
  );
  store.run(
    'DELETE FROM chat_sessions WHERE id = ? AND COALESCE(user_id, ?) = ?',
    [session.id, DEFAULT_RUNTIME_USER_ID, scope.userId]
  );
  await clearScopedRuntimeSessionState(store, scope, session.id);
  return { success: true };
}

export async function getAgentSession(store: any, agentId: number, options: ChatOwnershipOptions = {}): Promise<ChatSessionRow | null> {
  const scope = resolveScope(options);
  return mapSessionRow(
    store.get(
      `SELECT cs.* FROM chat_sessions cs
       WHERE cs.agent_id = ? AND COALESCE(cs.user_id, ?) = ?
       ORDER BY cs.last_message_at DESC
       LIMIT 1`,
      [agentId, DEFAULT_RUNTIME_USER_ID, scope.userId]
    ),
    scope.userId
  );
}

export async function createAgentSession(store: any, agentId: number, title: string | null = null, options: ChatOwnershipOptions = {}): Promise<ChatSessionRow> {
  const scope = resolveScope(options);
  const agent = await store.getAgent(agentId, scope);
  const sessionTitle = title || (agent ? `${agent.name}` : 'Agent Chat');
  const result = store.run(
    'INSERT INTO chat_sessions (title, agent_id, user_id) VALUES (?, ?, ?)',
    [sessionTitle, agentId, scope.userId]
  );
  return { id: result.id, title: sessionTitle, agent_id: agentId, user_id: scope.userId };
}
