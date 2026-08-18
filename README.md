<div align="center">
  
# 🧠 wellagent-core

**The headless architectural source of truth for composing agent-oriented applications.**

[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue?logo=typescript)](#)

</div>

<br />

`wellagent-core` is a lightweight, headless engine for orchestrating AI agents, tools, and memory. 

It contains **no** Electron bootstrap, **no** UI, **no** deployment setup, **no** rigid user databases, and **no** automatic plugin loading. It is purely the architectural foundation for building powerful, scalable agent systems on your own terms.

---

## 🚀 Quick Start

### Installation

Install directly from GitHub (or npm if published):

```bash
npm install github:dkeiz/wellagent-core
```

### The Minimal Runtime

Creating an agent runtime is incredibly simple. Below is a complete backend setup using the built-in in-memory storage.

```typescript
import { InMemoryDatabase, Runtime } from 'wellagent-core';

// 1. Initialize storage
const runtime = new Runtime({
  storage: new InMemoryDatabase(),
});

// 2. Start the engine
await runtime.start();

// 3. Register your LLM provider and execute tasks...
// (e.g. runtime.chat() or runtime.run())

// 4. Graceful shutdown
await runtime.shutdown();
```

> [!NOTE]  
> The default storage is strictly in-memory. `wellagent-core` deliberately avoids accepting database paths because **you** (the host) should own the database selection, migration strategy, identity logic, and deployment environments.

---

## 🏗️ Architecture & Layers

The core is split into distinct, highly decoupled layers:

| Layer | Responsibility | Default |
| :--- | :--- | :--- |
| ⚙️ **Core** | Composition, lifecycle, events, settings helpers | *Always available* |
| 💾 **Storage ports** | Settings, chat/session, agents, workflows, memory | *In-memory reference adapter* |
| 🧠 **Inference** | Provider base, dispatcher, context helpers | *Host supplies providers* |
| 🛠️ **Tools** | Validation, policy gate, concurrent tool-use loop | *No tools loaded* |
| 🤖 **Agents & Workflows** | Persistence-port-backed state and execution | *Enabled by Runtime* |
| 🧩 **Extensions** | File memory, code loading, remote transport, UI, shards | *Explicit opt-in only* |

> `Runtime` assembles the core. `createRuntime()` assembles arbitrary modules. 
> Use `Runtime` for a standard working agent backend, and `createRuntime()` when your application needs a heavily customized capability graph.

---

## 🛠️ Tools & Permissions

Tools automatically validate required parameters and types before handlers run. A security policy is always attached to `Runtime`. Unsafe or confirmation-required tools need an explicit grant.

```typescript
import { InMemoryDatabase, Runtime, ToolDefinition } from 'wellagent-core';

const approvedTool: ToolDefinition = {
  name: 'get_project_name',
  description: 'Return the configured project name',
  group: 'project',
  safe: true,
  handler: async () => ({ content: 'Example project' }),
};

const runtime = new Runtime({
  storage: new InMemoryDatabase(),
  tools: [approvedTool],
});

// Explicitly grant permission to the project group
runtime.permissions.setGroupEnabled('project', true);

await runtime.start();
```

---

## 💾 Custom Storage Portability

`wellagent-core` never executes SQL directly. Any SQL, ORM, document store, API, or test-double persistence belongs safely behind a custom storage port. You only need to implement the ports that your capability actually uses.

```typescript
import type { AgentStore, StoredAgent } from 'wellagent-core';

class MyAgents implements AgentStore {
  private records = new Map<string | number, StoredAgent>();

  async listAgents() { return [...this.records.values()]; }
  async saveAgent(agent: StoredAgent) { this.records.set(agent.id, agent); return agent; }
  async deleteAgent(id: string | number) { return this.records.delete(id); }
}
```

---

## 🧩 Extensions & Security Boundaries

Use extensions **only** when the host intentionally supplies a secure boundary. The library will never autonomously create plugin or connector directories on the filesystem during construction.

```typescript
import { extensions } from 'wellagent-core';

const plugins = new extensions.PluginManager({
  pluginsDir: './plugins',
  toolRegistry,
  db: storage,
  loader: {
    load: async (filePath) => require(filePath),
  },
  policy: {
    // Strict host policy enforcement
    allowPlugin: (manifest) => manifest.id === 'trusted-plugin',
  },
});
```

---

## 📜 Development Guidelines

When working with `wellagent-core`, adhere to the following principles:

1. **Explicit Composition**: Compose storage, providers, tools, and extensions explicitly.
2. **Host Agnostic**: Do not assume SQLite, a user model, filesystem persistence, UI, network access, or permission approval exists.
3. **Strict Boundaries**: Treat all extensions as capability requests that require a strict host policy.
4. **Use Exports**: Start from `wellagent-core` exports; do not rely on internal file paths.
5. **Precision Cancellation**: Include a `runId` when cancelling one concurrent ToolChain run. Calling `chain.stop(runId)` never cancels another run.
