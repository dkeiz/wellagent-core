# LocalAgent Library

lib/ is the architectural source of truth for composing an agent-oriented
application. It contains no Electron bootstrap, UI, deployment setup, user
database, or automatic plugin/process loading.

Use only exports from lib/index.ts. The examples use <library-entry> as the
future package or local entrypoint.

## Layers

| Layer | Responsibility | Default |
| --- | --- | --- |
| Core | composition, lifecycle, events, settings helpers | always available |
| Storage ports | settings, chat/session, agents, workflows, memory | in-memory reference adapter |
| Inference | provider base, dispatcher, context helpers | host supplies providers |
| Tools | validation, policy gate, concurrent tool-use loop | no tools loaded |
| Agents and workflows | persistence-port-backed state and execution | enabled by Runtime |
| Extensions | file memory, code loading, remote transport, UI, shards | explicit opt-in only |

Runtime assembles the core. createRuntime() assembles arbitrary modules. They
are complementary: use Runtime for a working agent backend and createRuntime()
when an application needs its own capability graph.

## Minimal runtime

~~~ts
import { InMemoryDatabase, Runtime } from '<library-entry>';

const runtime = new Runtime({
  storage: new InMemoryDatabase(),
});

await runtime.start();
// Register a provider before calling runtime.chat() or runtime.run().
await runtime.shutdown();
~~~

The default storage is in-memory. A database path is deliberately not accepted:
the host owns database selection, migration strategy, identity, and deployment.

## Custom storage

Implement only the ports the capability uses. The high-level Runtime accepts
the DatabaseAdapter convenience composite; an application that composes its own
modules can provide narrower ports.

~~~ts
import type { AgentStore, StoredAgent } from '<library-entry>';

class MyAgents implements AgentStore {
  private records = new Map<string | number, StoredAgent>();

  async listAgents() {
    return [...this.records.values()];
  }

  async saveAgent(agent: StoredAgent) {
    this.records.set(agent.id, agent);
    return agent;
  }

  async deleteAgent(id: string | number) {
    return this.records.delete(id);
  }
}
~~~

AgentManager and WorkflowManager never execute SQL. SQL, ORM, document store,
API, or test-double persistence belongs behind the relevant port.

## Provider and approved tool

~~~ts
import {
  InMemoryDatabase,
  Runtime,
  ToolDefinition,
} from '<library-entry>';

const storage = new InMemoryDatabase();
const approvedTool: ToolDefinition = {
  name: 'get_project_name',
  description: 'Return the configured project name',
  group: 'project',
  safe: true,
  handler: async () => ({ content: 'Example project' }),
};

const runtime = new Runtime({
  storage,
  tools: [approvedTool],
});

runtime.permissions.setGroupEnabled('project', true);
await runtime.start();
~~~

Tools validate required parameters and types before handlers run. A policy is
always attached to Runtime; unsafe or confirmation-required tools need an
explicit grant or configured enabled group. Call
runtime.permissions.setToolPermission(name, { allowed: true }) for a single
approved tool.

For custom providers, extend Provider, pass the host-owned settings store to its
constructor, and implement call() plus getModels(). The dispatcher selects an
explicit provider, then a scoped llm.provider setting, then the first registered
provider.

## Modules, agents, and workflows

~~~ts
import { createRuntime, type RuntimeModule } from '<library-entry>';

const auditModule: RuntimeModule = {
  id: 'audit',
  requires: ['storage'],
  register: ({ events }) => {
    events.define({ 'audit:started': { category: 'audit' } });
  },
  start: ({ events }) => events.publish('audit:started', {}),
};

const runtime = createRuntime({
  id: 'example',
  modules: [
    { id: 'storage' },
    auditModule,
  ],
});

await runtime.start();
await runtime.shutdown();
~~~

Modules register and start in dependency order. If startup fails, already
started modules stop in reverse order. Normal shutdown also uses reverse order.

Agents, workflows, and memory are normal services; they do not create database
tables, directories, or profiles. FileMemoryStore is an opt-in adapter when a
host explicitly wants Markdown-backed memory.

## Extensions

Use extensions only when the host intentionally supplies the security boundary:

~~~ts
import { extensions } from '<library-entry>';

const plugins = new extensions.PluginManager({
  pluginsDir: './plugins',
  toolRegistry,
  db: storage,
  loader: {
    load: async (filePath) => require(filePath),
  },
  policy: {
    allowPlugin: (manifest) => manifest.id === 'trusted-plugin',
  },
});
~~~

The library never creates plugin or connector directories during construction.
Plugin loading requires a host loader and policy. Connector execution requires a
host runner. Gateways and A2A servers require authentication for non-loopback
bindings. Tunnels require a host process runner.

## LLM working rules

- Start from <library-entry> exports; do not rely on internal file paths.
- Compose storage, providers, tools, and extensions explicitly.
- Do not assume SQLite, a user model, filesystem persistence, UI, network
  access, or permission approval exists.
- Treat extensions as capability requests that need host policy.
- Use RuntimeBlueprint and RuntimeModule for architecture; use Runtime for the
  standard core backend.
- Include a runId when cancelling one concurrent ToolChain run. Calling
  chain.stop(runId) never cancels another run.

