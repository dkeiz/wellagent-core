// ---------------------------------------------------------------------------
// lib/auth/index.ts — Auth layer barrel export
// ---------------------------------------------------------------------------

export { UserRegistry, DEFAULT_USER_ID } from './user-registry';
export type { RegisteredUser, UserRole, UserStatus, UserRegistryOverrides } from './user-registry';

export { RequestContextFactory } from './request-context';
export type { RequestContextOptions } from './request-context';

export { PermissionManager } from './permissions';
export type { PermissionScope, PermissionResult, PermissionRule } from './permissions';

export { SecretStore } from './secret-store';
