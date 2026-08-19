import type { RequestContext } from '../../shared/types';

export const DEFAULT_USER_ID = 'localuser';
export const LEGACY_DEFAULT_USER_ID = 'owner';

export interface ResolvedUserScope {
  concurrent: boolean;
  requestContext: RequestContext | Record<string, any>;
  userId: string;
}

function normalizeOptionalString(value: any): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function normalizeOptionalUserId(value: any): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return normalized === LEGACY_DEFAULT_USER_ID ? DEFAULT_USER_ID : normalized;
}

export function normalizeUserId(value: any, fallback: string = DEFAULT_USER_ID): string {
  return normalizeOptionalUserId(value) || fallback;
}

export function isBuiltInUserId(value: any): boolean {
  return normalizeUserId(value) === DEFAULT_USER_ID;
}

export function requireUserScope(input: any = {}, requestContextService: any = null): ResolvedUserScope {
  const options = input && typeof input === 'object' ? input : {};
  const requestContext = options.requestContext && typeof options.requestContext === 'object'
    ? (requestContextService?.normalizeRequestContext
        ? requestContextService.normalizeRequestContext(options.requestContext)
        : options.requestContext)
    : (requestContextService?.normalizeRequestContext
        ? requestContextService.normalizeRequestContext(options)
        : options);
  const concurrent = Boolean(requestContextService?.isConcurrentRequestContext?.(requestContext || {}));
  const explicitUserId = normalizeOptionalUserId(
    options.userId || options.user_id || requestContext?.userId || requestContext?.user_id
  );

  if (!explicitUserId && concurrent) {
    const source = normalizeOptionalString(requestContext?.source) || 'concurrent';
    throw new Error(`Missing user identity for ${source} request`);
  }

  return {
    concurrent,
    requestContext,
    userId: explicitUserId || DEFAULT_USER_ID
  };
}
