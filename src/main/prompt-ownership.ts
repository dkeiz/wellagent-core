// @ts-nocheck
import path = require('path');
import type { RequestContext } from '../../shared/types';

const requestContextHelpers = require('./request-context');
const { DEFAULT_USER_ID, normalizeUserId, requireUserScope } = require('./user-scope');

export const DEFAULT_PROMPT_USER_ID = DEFAULT_USER_ID;

export interface PromptOwnershipScope {
  requestContext: RequestContext | Record<string, any>;
  concurrent: boolean;
  userId: string;
}

export interface PromptOwnershipOptions {
  requestContext?: RequestContext | Record<string, any>;
  userId?: string;
  user_id?: string;
  [key: string]: any;
}

export interface ScopedPromptPaths extends PromptOwnershipScope {
  basePath: string;
  systemPromptPath: string;
  rulesPath: string;
}

export function normalizePromptUserId(value: any, fallback: string = DEFAULT_PROMPT_USER_ID): string {
  return normalizeUserId(value, fallback);
}

export function normalizePromptRequestContext(input = null, requestContextService = requestContextHelpers): RequestContext | Record<string, any> {
  if (requestContextService?.normalizeRequestContext) {
    return requestContextService.normalizeRequestContext(input || {});
  }
  return input || {};
}

export function resolvePromptScope(options: PromptOwnershipOptions = {}, requestContextService = requestContextHelpers): PromptOwnershipScope {
  return requireUserScope(options, requestContextService);
}

export function mapPromptRuleRow(row: any, fallbackUserId: string = DEFAULT_PROMPT_USER_ID): any {
  if (!row) return row;
  const active = row.active === 1 || row.active === true;
  return {
    ...row,
    active,
    user_id: normalizePromptUserId(row.user_id || row.userId, fallbackUserId)
  };
}

export function sanitizePromptUserFolder(userId: string = DEFAULT_PROMPT_USER_ID): string {
  return normalizePromptUserId(userId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || DEFAULT_PROMPT_USER_ID;
}

export function getScopedPromptBasePath(basePath: string, options: PromptOwnershipOptions = {}, requestContextService = requestContextHelpers): string {
  const scope = resolvePromptScope(options, requestContextService);
  if (scope.userId === DEFAULT_PROMPT_USER_ID) {
    return basePath;
  }
  return path.join(basePath, 'users', sanitizePromptUserFolder(scope.userId));
}

export function getScopedPromptPaths(basePath: string, options: PromptOwnershipOptions = {}, requestContextService = requestContextHelpers): ScopedPromptPaths {
  const scope = resolvePromptScope(options, requestContextService);
  const scopedBasePath = getScopedPromptBasePath(basePath, scope, requestContextService);
  return {
    ...scope,
    basePath: scopedBasePath,
    systemPromptPath: path.join(scopedBasePath, 'system.md'),
    rulesPath: path.join(scopedBasePath, 'rules')
  };
}
