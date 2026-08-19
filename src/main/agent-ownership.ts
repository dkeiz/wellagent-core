// @ts-nocheck
import path = require('path');
import type { RequestContext } from '../../shared/types';

const requestContextHelpers = require('./request-context');
const { DEFAULT_USER_ID, normalizeUserId, requireUserScope } = require('./user-scope');

export const DEFAULT_AGENT_USER_ID = DEFAULT_USER_ID;

export interface AgentOwnershipScope {
  requestContext: RequestContext | Record<string, any>;
  userId: string;
}

export interface AgentOwnershipOptions {
  requestContext?: RequestContext | Record<string, any>;
  userId?: string;
  user_id?: string;
  [key: string]: any;
}

export function normalizeAgentUserId(value: any, fallback: string = DEFAULT_AGENT_USER_ID): string {
  return normalizeUserId(value, fallback);
}

export function normalizeAgentRequestContext(input = null, requestContextService = requestContextHelpers): RequestContext | Record<string, any> {
  if (requestContextService?.normalizeRequestContext) {
    return requestContextService.normalizeRequestContext(input || {});
  }
  return input || {};
}

export function resolveAgentScope(options: AgentOwnershipOptions = {}, requestContextService = requestContextHelpers): AgentOwnershipScope {
  return requireUserScope(options, requestContextService);
}

export function mapAgentRow(row: any, fallbackUserId: string = DEFAULT_AGENT_USER_ID): any {
  if (!row) return row;
  return {
    ...row,
    visibleInSidebar: row.visible_in_sidebar !== 0,
    user_id: normalizeAgentUserId(row.user_id || row.userId, fallbackUserId)
  };
}

export function mapSubagentRunOwnership(row: any, fallbackUserId: string = DEFAULT_AGENT_USER_ID): any {
  return row
    ? { ...row, user_id: normalizeAgentUserId(row.user_id || row.userId, fallbackUserId) }
    : row;
}

export function sanitizeAgentUserFolder(userId: string = DEFAULT_AGENT_USER_ID): string {
  return normalizeAgentUserId(userId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || DEFAULT_AGENT_USER_ID;
}

export function getScopedAgentBasePath(basePath: string, options: AgentOwnershipOptions = {}, requestContextService = requestContextHelpers): string {
  const scope = resolveAgentScope(options, requestContextService);
  if (scope.userId === DEFAULT_AGENT_USER_ID) {
    return basePath;
  }
  const agentinRoot = path.dirname(path.resolve(basePath));
  return path.join(agentinRoot, 'users', sanitizeAgentUserFolder(scope.userId), 'agents');
}
