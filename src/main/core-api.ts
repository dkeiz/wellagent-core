import type { RequestContext } from '../../shared/types';

export interface CoreApiOptions {
  container: any;
}

export interface CoreApi {
  dispatchChat(prompt: string, history?: any[], options?: { sessionId?: string | null; agentId?: number | null; requestContext?: RequestContext | null; [key: string]: any }): Promise<any>;
  executeTool(toolName: string, params?: Record<string, any>, options?: { sessionId?: string | null; agentId?: number | null; requestContext?: RequestContext | null; principal?: any; [key: string]: any }): Promise<any>;
  getWorkflowRun(runId: string, options?: { requestContext?: RequestContext | null }): Promise<any>;
  listWorkflows(options?: { requestContext?: RequestContext | null; [key: string]: any }): Promise<any[]>;
  resolveRequestContext(input?: any): RequestContext | Record<string, any>;
  runWorkflow(workflowId: number | string, options?: { requestContext?: RequestContext | null; requestedBySessionId?: string | null; [key: string]: any }): Promise<any>;
}

export function createCoreApi(options: CoreApiOptions): CoreApi {
  const container = options?.container;
  if (!container) {
    throw new Error('Core API requires container');
  }

  function getService<T = any>(name: string): T {
    const service = container.optional?.(name) ?? container.get?.(name);
    if (!service) {
      throw new Error(`Core API service unavailable: ${name}`);
    }
    return service as T;
  }

  function resolveRequestContext(input: any = null): RequestContext | Record<string, any> {
    const requestContextService = container.optional?.('requestContextService');
    if (requestContextService?.normalizeRequestContext) {
      return requestContextService.normalizeRequestContext(input || {});
    }
    return input || {};
  }

  return {
    async dispatchChat(prompt: string, history: any[] = [], runtimeOptions: any = {}) {
      const dispatcher = getService('dispatcher');
      return dispatcher.dispatch(prompt, history, {
        ...runtimeOptions,
        mode: runtimeOptions.mode || 'chat',
        requestContext: resolveRequestContext(runtimeOptions.requestContext || null)
      });
    },

    async executeTool(toolName: string, params: Record<string, any> = {}, runtimeOptions: any = {}) {
      const mcpServer = getService('mcpServer');
      return mcpServer.executeTool(toolName, params, null, {
        context: {
          sessionId: runtimeOptions.sessionId || null,
          agentId: runtimeOptions.agentId || null,
          source: runtimeOptions.source || 'core-api',
          principal: runtimeOptions.principal || null,
          requestContext: resolveRequestContext(runtimeOptions.requestContext || null)
        }
      });
    },

    async runWorkflow(workflowId: number | string, workflowOptions: any = {}) {
      const workflowManager = getService('workflowManager');
      return workflowManager.runWorkflow(workflowId, {
        ...workflowOptions,
        requestContext: resolveRequestContext(workflowOptions.requestContext || null)
      });
    },

    async listWorkflows(listOptions: any = {}) {
      const workflowManager = getService('workflowManager');
      return workflowManager.getWorkflows({
        ...listOptions,
        requestContext: resolveRequestContext(listOptions.requestContext || null)
      });
    },

    async getWorkflowRun(runId: string, runOptions: any = {}) {
      const workflowManager = getService('workflowManager');
      return workflowManager.getWorkflowRun(runId, {
        ...runOptions,
        requestContext: resolveRequestContext(runOptions.requestContext || null)
      });
    },

    resolveRequestContext
  };
}
