// ---------------------------------------------------------------------------
// lib/runtime.ts — Core runtime facade assembled from explicit capabilities
// ---------------------------------------------------------------------------

import type { Container } from './core/container';
import { createRuntime, type RuntimeHandle, type RuntimeModule } from './core/composition';
import type { EventBus } from './core/events';
import type { LLMResponse, Logger, Message, ToolDefinition } from './core/types';
import { AgentLoop } from './agents/agent-loop';
import { AgentManager } from './agents/manager';
import { AgentMemory } from './agents/memory';
import { SubagentRuntime } from './agents/subagent';
import { Dispatcher, type Provider } from './inference';
import { InMemoryDatabase, type DatabaseAdapter, type MemoryStore } from './storage';
import { ToolChain, ToolPermissions, ToolRegistry, resolveToolSets, type ChainResult } from './tools';
import { WorkflowManager, WorkflowRuntime, WorkflowScheduler } from './workflows';

export interface RuntimeOptions {
  id?: string;
  /** Explicit persistence implementation. Defaults to the in-memory reference adapter. */
  storage?: DatabaseAdapter;
  /** @deprecated Use storage. Paths are intentionally not accepted by the library. */
  db?: DatabaseAdapter;
  providers?: Provider[];
  tools?: (string | ToolDefinition)[];
  modules?: RuntimeModule[];
  workspaceRoot?: string;
  agents?: {
    memory?: boolean;
    memoryStore?: MemoryStore;
  };
  workflows?: {
    schedulerEnabled?: boolean;
  };
  logger?: Logger;
}

/**
 * High-level runtime for the dependable core capabilities only.
 *
 * Remote transports, plugin loading, connector execution, UI, and deployment
 * remain explicit opt-in extensions and are never constructed here.
 */
export class Runtime {
  readonly composition: RuntimeHandle;
  readonly container: Container;
  readonly db: DatabaseAdapter;
  readonly storage: DatabaseAdapter;
  readonly events: EventBus;
  readonly dispatcher: Dispatcher;
  readonly tools: ToolRegistry;
  readonly permissions: ToolPermissions;
  readonly agents: AgentManager;
  readonly memory: AgentMemory | null;
  readonly agentLoop: AgentLoop | null;
  readonly subagents: SubagentRuntime;
  readonly workflows: WorkflowManager;
  readonly workflowRuntime: WorkflowRuntime;
  readonly workflowScheduler: WorkflowScheduler | null;
  readonly chain: ToolChain;

  constructor(options: RuntimeOptions = {}) {
    const logger = options.logger ?? console;
    this.storage = options.storage ?? options.db ?? new InMemoryDatabase({ logger });
    this.db = this.storage;

    this.dispatcher = new Dispatcher(this.storage, { providers: options.providers, logger });
    this.permissions = new ToolPermissions(this.storage, { logger });
    this.tools = new ToolRegistry({ logger, policy: this.permissions });
    this.agents = new AgentManager(this.storage, { logger });
    this.memory = options.agents?.memory === false
      ? null
      : new AgentMemory({ store: options.agents?.memoryStore ?? this.storage, logger });
    this.agentLoop = this.memory
      ? new AgentLoop({ dispatcher: this.dispatcher, memory: this.memory, db: this.storage, logger })
      : null;
    registerTools(this.tools, this.permissions, options.tools, options.workspaceRoot, this.memory);
    this.chain = new ToolChain(this.dispatcher, this.tools, { logger });
    this.subagents = new SubagentRuntime(this.dispatcher, this.tools, { logger });

    this.workflows = new WorkflowManager(this.storage, { logger });
    this.workflowRuntime = new WorkflowRuntime(
      this.workflows,
      this.tools,
      this.dispatcher,
      { logger }
    );
    this.workflowScheduler = options.workflows?.schedulerEnabled
      ? new WorkflowScheduler(this.workflows, this.workflowRuntime, { logger })
      : null;

    const modules: RuntimeModule[] = [
      {
        id: 'storage',
        start: () => this.storage.init(),
        stop: () => this.storage.close(),
      },
      {
        id: 'agents',
        requires: ['storage'],
        start: async () => {
          await this.agents.init();
          await this.memory?.load();
        },
      },
      {
        id: 'workflows',
        requires: ['storage'],
        start: async () => {
          await this.workflows.init();
          this.workflowScheduler?.start();
        },
        stop: () => this.workflowScheduler?.stop(),
      },
      {
        id: 'subagents',
        requires: ['storage'],
        stop: () => this.subagents.stopAll(),
      },
      ...(options.modules || []),
    ];

    this.composition = createRuntime({
      id: options.id || 'localagent-runtime',
      logger,
      services: {
        storage: this.storage,
        db: this.db,
        dispatcher: this.dispatcher,
        toolRegistry: this.tools,
        toolPermissions: this.permissions,
        toolChain: this.chain,
        agentManager: this.agents,
        agentMemory: this.memory,
        agentLoop: this.agentLoop,
        workflowManager: this.workflows,
        workflowRuntime: this.workflowRuntime,
        workflowScheduler: this.workflowScheduler,
      },
      modules,
    });
    this.container = this.composition.container;
    this.container.replace('runtime', this);
    this.events = this.composition.events;
    this.workflowRuntime.setEventBus?.(this.events);
  }

  async start(): Promise<void> {
    await this.composition.start();
  }

  async shutdown(): Promise<void> {
    await this.composition.shutdown();
  }

  async chat(
    prompt: string,
    options: { history?: Message[]; sessionId?: string; userId?: string; requestContext?: any } = {}
  ): Promise<LLMResponse> {
    return this.dispatcher.dispatch(prompt, options.history || [], {
      sessionId: options.sessionId,
      userId: options.userId,
      requestContext: options.requestContext,
    });
  }

  async run(
    prompt: string,
    options: {
      runId?: string;
      history?: Message[];
      maxSteps?: number;
      sessionId?: string;
      userId?: string;
      requestContext?: any;
    } = {}
  ): Promise<ChainResult> {
    return this.chain.run(prompt, options.history || [], {
      runId: options.runId,
      maxSteps: options.maxSteps,
      sessionId: options.sessionId,
      userId: options.userId,
      requestContext: options.requestContext,
    });
  }

  async executeTool(
    name: string,
    params: Record<string, any> = {},
    context: Record<string, any> = {}
  ): Promise<any> {
    const result = await this.tools.execute(name, params, context);
    return result.result;
  }

  get isStarted(): boolean {
    return this.composition.isStarted;
  }
}

function registerTools(
  registry: ToolRegistry,
  permissions: ToolPermissions,
  configured: (string | ToolDefinition)[] | undefined,
  workspaceRoot: string | undefined,
  memory: AgentMemory | null
): void {
  if (!configured?.length) return;

  const names: string[] = [];
  const custom: ToolDefinition[] = [];
  for (const item of configured) {
    if (typeof item === 'string') names.push(item);
    else custom.push(item);
  }
  registry.registerBatch(resolveToolSets(names, {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    memory: memory || undefined,
  }));
  registry.registerBatch(custom);

  const groups = new Map<string, string[]>();
  for (const tool of registry.list({ includeHidden: true })) {
    const group = tool.group || 'custom';
    const namesForGroup = groups.get(group) || [];
    namesForGroup.push(tool.name);
    groups.set(group, namesForGroup);
  }
  for (const [group, toolNames] of groups) {
    permissions.defineGroup(group, toolNames, group === 'core');
  }
}
