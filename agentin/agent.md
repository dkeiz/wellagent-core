# Agent Technical Reference

This document is the detailed technical reference for Well (LocalAgent LLM).

## Memory System

### Structure
```
agentin/memory/
├── daily/          YYYY-MM-DD.md — daily work logs
├── global/         preferences.md — permanent user info
├── tasks/          task-specific working notes
└── images/         visual captures from screenshot tool
```

### API (via AgentMemory)
- **append(type, content, filename?)** — append-only write with timestamp. Types: `daily`, `global`, `tasks`
- **read(type, filename?)** — read file content with integrity check
- **list(type)** — list all files in a memory type
- **saveImage(buffer, name?)** — save image to `images/`
- **getStats()** — file counts per type, locked file count

### Rules
- Append-only: new entries added, never modified
- Auto-lock: files older than 7 days become immutable
- Hash verification: SHA-256 integrity checking, tamper detection

### User Info
`agentin/userabout/memoryaboutuser.md` — store dated observations about the user.

---

## Conversation System

### Database (SQLite)
- `chat_sessions` — id, title, created_at, last_active
- `conversations` — id, session_id, role, content, timestamp

### Tools
- `conversation_history` — get recent messages (limit param)
- `search_conversations` — keyword search across all sessions

### Multi-Chat
Each chat tab = independent session with own history. Sessions persist across app restarts.

---

## Tool System

### Tool Call Format
```
TOOL:tool_name{"param":"value","param2":123}
```

### Tool Chaining
The backend auto-continues when you call a tool that returns data. Max 10 chain steps. Use `end_answer{"answer":"..."}` to finalize.

### Capability Groups
Tools are organized in groups toggled via the capability panel. Check `tool-classification.json` for current state. Main switch must be ON for any tools.

### Custom Tools
`create_tool` writes to DB + registers at runtime. Custom tools default to unsafe group unless promoted. Code is stored as a string and eval'd.

---

## Workflow System

### Overview
Workflows are reusable multi-tool sequences stored in the database. They automate repetitive tasks.

### Tools
- `workflow_op` — unified workflow operations via action parameter

### Auto-Capture
Successful multi-tool chains can be auto-captured as workflows (when enabled via settings). Captured workflows include:
- Trigger pattern (from user message)
- Tool sequence with params
- Auto-generated name

### Copy Pattern
Use `workflow_op` with `action:"copy"` to clone a proven workflow, then modify it for a different purpose.

### Visual Editor
Users can also build workflows in the Workflows tab using a drag-and-drop node editor with tool connections.

### Reference
Full documentation: `agentin/workflows/workflow.md`

---

## Prompt Rules

### Structure
Files in `agentin/prompts/rules/` with YAML frontmatter:
```yaml
---
name: Rule Name
active: true
priority: 1
---
Rule content injected into system prompt when active.
```

### Tools
- `manage_rule` — create/update/delete/toggle rules (writes file + DB)
- `list_rules` — list all rules with status
- `toggle_rule` — activate/deactivate by ID
- `list_active_rules` — currently active rules

---

## Connector System

### Overview
External service integrations as JS scripts in `agentin/connectors/`. Each runs in a `worker_thread` with hooks to the backend.

### Connector Interface
Every `agentin/connectors/*.js` (except `_`-prefixed) exports:
```javascript
module.exports = {
  name: 'connector-name',
  description: 'What it does',
  configSchema: {
    apiToken: { type: 'string', required: true, description: 'API token' }
  },
  async start(context) {
    // context.invoke(prompt) → full LLM pipeline → response string
    // context.config → stored config values (from DB, not file)
    // context.log(msg) → event log visible in UI
  },
  async stop() { /* cleanup */ }
};
```

### Creation Flow
1. User requests integration (e.g., "add my Telegram")
2. Ask user for required config (API tokens, usernames)
3. Store config via `connector_op` with `action:"config_set"` (secrets in DB, never in file)
4. Write connector JS file via `write_file`
5. Install dependencies if needed (ask user, then `run_command`)
6. Start via `connector_op` with `action:"start"`

### Tools
- `connector_op` — unified connector actions: create/start/stop/list/config_get/config_set

### Pre-built
`telegram-bot.js` — Telegram bot relay. Needs `node-telegram-bot-api` + bot token.

---

## AutoMemory

Off by default. User enables per-session via `automemory` tool.
When enabled: after 1 minute idle + 6 messages, backend triggers internal LLM call to summarize conversation into daily memory. Also triggers on chat close (4+ messages).

---

## Environment

Paths injected each turn:
- Working Directory: `<app root>`
- Memory Directory: `<app root>/agentin/memory`
- Agent Config: `<app root>/agentin`
- Connectors: `<app root>/agentin/connectors`
