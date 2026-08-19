import type { RequestContext, RequestContextSource, UserIdentity } from '../../shared/types';
import type { RegisteredUser, UserRegistry, UserRegistryOverrides } from './user-registry';

export interface UserRequestContextOptions {
  deviceId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  user?: RegisteredUser | Partial<UserIdentity> | string | null;
  userId?: string | null;
}

export interface UserAuthOptions {
  [key: string]: any;
  activeUser?: RegisteredUser | null;
  userRegistry: UserRegistry;
  onActiveUserChanged?: (user: RegisteredUser, previous: RegisteredUser | null) => void;
}

export interface UserAuthService {
  createElectronRequestContext: (options?: UserRequestContextOptions) => RequestContext;
  createHeadlessRequestContext: (options?: UserRequestContextOptions) => RequestContext;
  createRequestContext: (source: RequestContextSource, options?: UserRequestContextOptions) => RequestContext;
  createA2ARequestContext: (user?: RegisteredUser | Partial<UserIdentity> | string | null, options?: UserRequestContextOptions) => RequestContext;
  createWwwGateRequestContext: (user?: RegisteredUser | Partial<UserIdentity> | string | null, options?: UserRequestContextOptions) => RequestContext;
  ensureUser: (userId: string, overrides?: UserRegistryOverrides) => RegisteredUser;
  getActiveUser: () => RegisteredUser;
  getUser: (userId: string) => RegisteredUser | null;
  listUsers: () => RegisteredUser[];
  resolveUser: (input?: RegisteredUser | Partial<UserIdentity> | string | null, fallbackUserId?: string | null) => RegisteredUser | Partial<UserIdentity> | null;
  setActiveUser: (user: RegisteredUser | string) => RegisteredUser;
}

function optional(value: any): string | null {
  return String(value || '').trim() || null;
}

function buildIdentity(input: Partial<UserIdentity> = {}): Partial<UserIdentity> | null {
  const userId = optional(input.userId);
  if (!userId) return null;
  return {
    userId,
    role: input.role === 'member' || input.role === 'guest' || input.role === 'owner' ? input.role : undefined,
    username: optional(input.username) || undefined,
    displayName: optional(input.displayName) || undefined
  };
}

export function createUserAuth(options: UserAuthOptions): UserAuthService {
  const userRegistry = options?.userRegistry;
  if (!userRegistry) throw new Error('userRegistry is required for user auth');
  let activeUser = options.activeUser || userRegistry.getDefaultUser();

  function getActiveUser(): RegisteredUser {
    return activeUser || userRegistry.getDefaultUser();
  }

  function resolveUser(input: RegisteredUser | Partial<UserIdentity> | string | null = null, fallbackUserId: string | null = null) {
    if (typeof input === 'string') return userRegistry.getUser(input);
    if (input?.userId) return userRegistry.getUser(input.userId) || buildIdentity(input);
    if (fallbackUserId) return userRegistry.getUser(fallbackUserId);
    return getActiveUser();
  }

  function createRequestContext(source: RequestContextSource, requestOptions: UserRequestContextOptions = {}): RequestContext {
    const resolvedUser = resolveUser(requestOptions.user || null, requestOptions.userId || null);
    return {
      source,
      userId: optional(resolvedUser?.userId) || undefined,
      sessionId: optional(requestOptions.sessionId) || undefined,
      deviceId: optional(requestOptions.deviceId) || undefined,
      requestId: optional(requestOptions.requestId) || undefined
    };
  }

  return {
    createElectronRequestContext: (requestOptions = {}) => createRequestContext('electron', requestOptions),
    createHeadlessRequestContext: (requestOptions = {}) => createRequestContext('headless', requestOptions),
    createRequestContext,
    createA2ARequestContext(user = null, requestOptions = {}) {
      return createRequestContext('a2a', { ...requestOptions, user: user || requestOptions.user || null });
    },
    createWwwGateRequestContext(user = null, requestOptions = {}) {
      return createRequestContext('www-gate', { ...requestOptions, user: user || requestOptions.user || null });
    },
    ensureUser: (userId, overrides = {}) => userRegistry.ensureUser(userId, overrides),
    getActiveUser,
    getUser: (userId) => userRegistry.getUser(userId),
    listUsers: () => userRegistry.listUsers(),
    resolveUser,
    setActiveUser(user) {
      const next = typeof user === 'string' ? userRegistry.getUser(user) : user;
      if (!next?.userId) throw new Error(`User not found: ${String(user || '')}`);
      const previous = activeUser || null;
      activeUser = next;
      options.onActiveUserChanged?.(next, previous);
      return next;
    }
  };
}
