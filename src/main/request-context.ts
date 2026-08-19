import type { RequestContext, RequestContextSource } from '../../shared/types';
const { DEFAULT_USER_ID, normalizeOptionalUserId } = require('./user-scope');

export const CONCURRENT_SOURCES: Set<string> = new Set(['companion', 'a2a', 'www-gate', 'headless']);

function normalizeString(value: any): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function normalizeRequestContext(input: any = {}): RequestContext {
  const source = String(input?.source || 'unknown').trim().toLowerCase() as RequestContextSource || 'unknown';
  return {
    source,
    userId: normalizeOptionalUserId(input?.userId || input?.user_id) || undefined,
    sessionId: normalizeString(input?.sessionId || input?.session_id) || undefined,
    deviceId: normalizeString(input?.deviceId || input?.device_id) || undefined,
    requestId: normalizeString(input?.requestId || input?.request_id) || undefined
  };
}

export function isConcurrentRequestContext(input: any = {}): boolean {
  const context = normalizeRequestContext(input);
  return CONCURRENT_SOURCES.has(context.source);
}

export function buildScopedSettingKey(kind: string, input: any = {}): string {
  const context = normalizeRequestContext(input);
  const principal = context.userId || context.deviceId || DEFAULT_USER_ID;
  return 'request_context.' + String(kind || 'session').trim().toLowerCase() + '.' + context.source + '.' + principal;
}

export async function getScopedSetting(db: any, kind: string, input: any = {}): Promise<string | null> {
  if (!db?.getSetting || !isConcurrentRequestContext(input)) {
    return null;
  }
  const value = await db.getSetting(buildScopedSettingKey(kind, input));
  return normalizeString(value);
}

export async function setScopedSetting(db: any, kind: string, input: any = {}, value: string = ''): Promise<{ key: string; value: string } | null> {
  if (!db?.saveSetting || !isConcurrentRequestContext(input)) {
    return null;
  }
  const key = buildScopedSettingKey(kind, input);
  const normalized = normalizeString(value) || '';
  await db.saveSetting(key, normalized);
  return { key, value: normalized };
}

export async function clearScopedSetting(db: any, kind: string, input: any = {}): Promise<{ key: string; value: string } | null> {
  return setScopedSetting(db, kind, input, '');
}

export async function getPreferredSessionId(db: any, input: any = {}): Promise<string | null> {
  return getScopedSetting(db, 'session', input);
}

export async function setPreferredSessionId(db: any, input: any = {}, sessionId: string = ''): Promise<{ key: string; value: string } | null> {
  return setScopedSetting(db, 'session', input, sessionId);
}

export async function clearPreferredSessionId(db: any, input: any = {}): Promise<{ key: string; value: string } | null> {
  return clearScopedSetting(db, 'session', input);
}

export function createCompanionRequestContext(device: any = {}, overrides: any = {}): RequestContext {
  return normalizeRequestContext({
    source: 'companion',
    deviceId: device?.deviceId || null,
    requestId: overrides?.requestId || null,
    sessionId: overrides?.sessionId || null,
    userId: overrides?.userId || device?.userId || null
  });
}
