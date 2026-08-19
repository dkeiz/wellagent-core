import type { RequestContext } from '../../shared/types';

const requestContextHelpers = require('./request-context');
const { requireUserScope } = require('./user-scope');

export function normalizeRequestContext(requestContext: any = null, requestContextService: any = requestContextHelpers): RequestContext | Record<string, any> {
  if (requestContextService?.normalizeRequestContext) {
    return requestContextService.normalizeRequestContext(requestContext || {});
  }
  return requestContext || {};
}

export function getRequestUserId(requestContext: any = null, requestContextService: any = requestContextHelpers): string {
  return requireUserScope(requestContext || {}, requestContextService).userId;
}

export function getWorkflowRunRequestContext(run: any = {}, requestContextService: any = requestContextHelpers): RequestContext | Record<string, any> {
  return normalizeRequestContext(run?.request_context || run?.requestContext || {
    source: 'workflow',
    userId: run?.requested_by_user_id || null,
    sessionId: run?.requested_by_session_id || null,
    deviceId: run?.requested_by_device_id || null,
    requestId: run?.requested_by_request_id || null
  }, requestContextService);
}

export function canAccessWorkflowRun(run: any = {}, requestContext: any = null, requestContextService: any = requestContextHelpers): boolean {
  const runUserId = getRequestUserId(getWorkflowRunRequestContext(run, requestContextService), requestContextService);
  const activeUserId = getRequestUserId(requestContext, requestContextService);
  return runUserId === activeUserId;
}
