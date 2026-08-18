// ---------------------------------------------------------------------------
// lib/auth/permissions.ts — Access control and permission checks
// ---------------------------------------------------------------------------

import type { RequestContext, Logger } from '../core/types';
import type { RegisteredUser, UserRole } from './user-registry';

/** Permission scope — what resource is being accessed. */
export interface PermissionScope {
  resource: string;       // e.g. 'agent', 'workflow', 'settings', 'tool'
  action: string;         // e.g. 'read', 'write', 'execute', 'delete'
  resourceId?: string;    // optional specific ID
  ownerId?: string;       // who owns this resource
}

/** Permission check result. */
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  requiredRole?: UserRole;
}

/** Permission rule. */
export interface PermissionRule {
  resource: string;
  action: string;
  roles: UserRole[];      // which roles can do this
  ownerOnly?: boolean;    // only the resource owner can do this
}

/** Default permission rules. */
const DEFAULT_RULES: PermissionRule[] = [
  // Owners can do everything
  { resource: '*', action: '*', roles: ['owner'] },

  // Members can read most things
  { resource: 'agent', action: 'read', roles: ['owner', 'member'] },
  { resource: 'agent', action: 'execute', roles: ['owner', 'member'] },
  { resource: 'agent', action: 'write', roles: ['owner', 'member'], ownerOnly: true },
  { resource: 'agent', action: 'delete', roles: ['owner', 'member'], ownerOnly: true },

  { resource: 'workflow', action: 'read', roles: ['owner', 'member'] },
  { resource: 'workflow', action: 'execute', roles: ['owner', 'member'] },
  { resource: 'workflow', action: 'write', roles: ['owner', 'member'], ownerOnly: true },

  { resource: 'tool', action: 'execute', roles: ['owner', 'member'] },
  { resource: 'tool', action: 'read', roles: ['owner', 'member', 'guest'] },

  { resource: 'settings', action: 'read', roles: ['owner', 'member'] },
  { resource: 'settings', action: 'write', roles: ['owner'] },

  { resource: 'chat', action: 'read', roles: ['owner', 'member', 'guest'] },
  { resource: 'chat', action: 'write', roles: ['owner', 'member'] },

  // Guests can only read
  { resource: '*', action: 'read', roles: ['owner', 'member', 'guest'] },
];

/**
 * Permission manager — role-based access control.
 *
 * Usage:
 * ```typescript
 * const perms = new PermissionManager();
 * const result = perms.check(
 *   { userId: 'alice', role: 'member' },
 *   { resource: 'agent', action: 'delete', ownerId: 'bob' }
 * );
 * if (!result.allowed) console.log(result.reason);
 * ```
 */
export class PermissionManager {
  private _rules: PermissionRule[];
  private _logger: Logger;

  constructor(options: { rules?: PermissionRule[]; logger?: Logger } = {}) {
    this._rules = options.rules || [...DEFAULT_RULES];
    this._logger = options.logger ?? console;
  }

  /**
   * Check if a user has permission for an action.
   */
  check(user: RegisteredUser | { userId: string; role: UserRole }, scope: PermissionScope): PermissionResult {
    const role = user.role || 'guest';

    // Owner role bypasses all checks
    if (role === 'owner') {
      return { allowed: true };
    }

    // Find matching rules (most specific first)
    const matches = this._rules.filter(r =>
      (r.resource === scope.resource || r.resource === '*') &&
      (r.action === scope.action || r.action === '*') &&
      r.roles.includes(role)
    );

    if (matches.length === 0) {
      return {
        allowed: false,
        reason: `Role '${role}' does not have '${scope.action}' permission on '${scope.resource}'`,
        requiredRole: 'owner',
      };
    }

    // Check ownerOnly rules
    const bestMatch = matches.find(r => r.resource === scope.resource) || matches[0];
    if (bestMatch.ownerOnly && scope.ownerId && scope.ownerId !== user.userId) {
      return {
        allowed: false,
        reason: `Only the resource owner can '${scope.action}' this '${scope.resource}'`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check permission from a RequestContext.
   */
  checkContext(
    context: RequestContext,
    scope: PermissionScope,
    resolveUser: (userId: string) => RegisteredUser | null
  ): PermissionResult {
    if (!context.userId) {
      return { allowed: false, reason: 'No user identity in request context' };
    }

    const user = resolveUser(context.userId);
    if (!user) {
      return { allowed: false, reason: `Unknown user: ${context.userId}` };
    }

    return this.check(user, scope);
  }

  /**
   * Add a custom permission rule.
   */
  addRule(rule: PermissionRule): void {
    this._rules.push(rule);
  }

  /**
   * Get all rules.
   */
  getRules(): PermissionRule[] {
    return [...this._rules];
  }
}
