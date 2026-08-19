// @ts-nocheck
import type { RequestContext } from '../../shared/types';

const requestContextHelpers = require('./request-context');
const { DEFAULT_USER_ID, normalizeUserId, requireUserScope } = require('./user-scope');

export const DEFAULT_WORKFLOW_USER_ID = DEFAULT_USER_ID;

export interface WorkflowOwnershipScope {
  requestContext: RequestContext | Record<string, any>;
  userId: string;
}

export interface WorkflowOwnershipOptions {
  requestContext?: RequestContext | Record<string, any>;
  userId?: string;
  user_id?: string;
  [key: string]: any;
}

export function normalizeWorkflowUserId(value: any, fallback: string = DEFAULT_WORKFLOW_USER_ID): string {
  return normalizeUserId(value, fallback);
}

export function normalizeWorkflowRequestContext(input = null, requestContextService = requestContextHelpers): RequestContext | Record<string, any> {
  if (requestContextService?.normalizeRequestContext) {
    return requestContextService.normalizeRequestContext(input || {});
  }
  return input || {};
}

export function resolveWorkflowScope(options: WorkflowOwnershipOptions = {}, requestContextService = requestContextHelpers): WorkflowOwnershipScope {
  return requireUserScope(options, requestContextService);
}

export function mapWorkflowRow(row: any, fallbackUserId: string = DEFAULT_WORKFLOW_USER_ID): any {
  return row ? {
    ...row,
    user_id: normalizeWorkflowUserId(row.user_id || row.userId, fallbackUserId)
  } : row;
}
