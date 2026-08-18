# wellagent-core

`wellagent-core` is the architectural source of truth for composing an agent-oriented application. It contains no Electron bootstrap, UI, deployment setup, user database, or automatic plugin/process loading. It is purely the headless engine for orchestrating AI agents, tools, and memory.

## Installation

```bash
npm install wellagent-core
```
*(Or install directly from GitHub if not published to npm).*

## Layers

| Layer | Responsibility | Default |
| --- | --- | --- |
| Core | composition, lifecycle, events, settings helpers | always available |
| Storage ports | settings, chat/session, agents, workflows, memory | in-memory reference adapter |
| Inference | provider base, dispatcher, context helpers | host supplies providers |
| Tools | validation, policy gate, concurrent tool-use loop | no tools loaded |
| Agents and workflows | persistence-port-backed state and execution | enabled by Runtime |
| Extensions | file memory, code loading, remote transport, UI, shards | explicit opt-in only |

Runtime assembles the core. `createRuntime()` assembles arbitrary modules. They are complementary: use `Runtime` for a working agent backend and `createRuntime()` when an application needs its own capability graph.

## Minimal runtime

```ts
import { InMemoryDatabase, Runtime } from 'wellagent-core';

const runtime = new Runtime({
  storage: new InMemoryDatabase(),
});

await runtime.start();
// Register a provider before calling runtime.chat() or runtime.run().
await runtime.shutdown();
```

The default storage is in-memory. A database path is deliberately not accepted: the host owns database selection, migration strategy, identity, and deployment.

## Custom storage

Implement only the ports the capability uses. The high-level Runtime accepts the DatabaseAdapter convenience composite; an application that composes its own modules can provide narrower ports.

```ts
import type { AgentStore, StoredAgent } from 'wellagent-core';

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
```

AgentManager and WorkflowManager never execute SQL. SQL, ORM, document store, API, or test-double persistence belongs behind the relevant port.

## Provider and approved tool

```ts
import {
  InMemoryDatabase,
  Runtime,
  ToolDefinition,
} from 'wellagent-core';

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
```

Tools validate required parameters and types before handlers run. A policy is always attached to Runtime; unsafe or confirmation-required tools need an explicit grant or configured enabled group. Call `runtime.permissions.setToolPermission(name, { allowed: true })` for a single approved tool.

## Modules, agents, and workflows

```ts
import { createRuntime, type RuntimeModule } from 'wellagent-core';

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
```

## Extensions

Use extensions only when the host intentionally supplies the security boundary:

```ts
import { extensions } from 'wellagent-core';

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
```

The library never creates plugin or connector directories during construction. Plugin loading requires a host loader and policy. Connector execution requires a host runner. Gateways and A2A servers require authentication for non-loopback bindings. Tunnels require a host process runner.
