// ---------------------------------------------------------------------------
// lib/auth/request-context.ts — Request context factory
// ---------------------------------------------------------------------------

import type { RequestContext, RequestContextSource } from '../core/types';
import type { RegisteredUser, UserRegistry } from './user-registry';

export interface RequestContextOptions {
  userId?: string | null;
  profileId?: string | null;
  sessionId?: string | null;
  deviceId?: string | null;
  requestId?: string | null;
  user?: RegisteredUser | { userId?: string; profileId?: string } | string | null;
}

/**
 * Creates request contexts — the per-request identity envelope
 * that flows through the entire system.
 *
 * Usage:
 * ```typescript
 * const auth = new RequestContextFactory(userRegistry);
 * const ctx = auth.create('electron', { userId: 'alice', sessionId: 'sess-1' });
 * // Pass ctx to any service method that needs scoping
 * ```
 */
export class RequestContextFactory {
  private _registry: UserRegistry;
  private _activeProfileId: string | null;

  constructor(registry: UserRegistry, options: { activeProfileId?: string | null } = {}) {
    this._registry = registry;
    this._activeProfileId = options.activeProfileId ?? null;
  }

  /**
   * Create a request context.
   */
  create(source: RequestContextSource, options: RequestContextOptions = {}): RequestContext {
    const user = this._resolveUser(options);
    return {
      source,
      userId: norm(user?.userId) || undefined,
      profileId: norm(options.profileId || user?.profileId || this._activeProfileId) || undefined,
      sessionId: norm(options.sessionId) || undefined,
      deviceId: norm(options.deviceId) || undefined,
      requestId: norm(options.requestId) || `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    };
  }

  /** Convenience: electron context. */
  electron(options: RequestContextOptions = {}): RequestContext {
    return this.create('electron', options);
  }

  /** Convenience: headless context. */
  headless(options: RequestContextOptions = {}): RequestContext {
    return this.create('headless', options);
  }

  /** Convenience: A2A context. */
  a2a(options: RequestContextOptions = {}): RequestContext {
    return this.create('a2a', options);
  }

  /** Convenience: companion/www-gate context. */
  companion(options: RequestContextOptions = {}): RequestContext {
    return this.create('companion', options);
  }

  private _resolveUser(options: RequestContextOptions): RegisteredUser | { userId?: string; profileId?: string } | null {
    const input = options.user;
    if (typeof input === 'string') {
      return this._registry.getUser(input);
    }
    if (input && typeof input === 'object' && (input as any).userId) {
      return this._registry.getUser((input as any).userId) || input;
    }
    if (options.userId) {
      return this._registry.getUser(options.userId);
    }
    return this._registry.getDefaultUser();
  }
}

function norm(value: any): string | null {
  const s = String(value || '').trim();
  return s || null;
}
