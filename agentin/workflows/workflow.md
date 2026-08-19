# Workflow System Reference

This document explains the workflow system — how to create, manage, and execute automated multi-tool sequences.

## Architecture: File-First

Workflows are **file-first** — they live as JSON files in `agentin/workflows/*.json`. The database logs execution stats but is not the source of truth.

**Flow:**
1. A `.json` file is placed in `agentin/workflows/`
2. On any read (tab open, `workflow_op` with `action:"list"`), the folder is scanned and synced to DB
3. The DB tracks stats: `success_count`, `failure_count`, `last_used`
4. All mutations (create, copy, delete) write/remove files first, then update DB

## File Format

Each `.json` file in `agentin/workflows/` defines one workflow. The old flat file format still works:

```json
{
  "name": "Morning Briefing",
  "description": "Lists calendar events, todos, and a quick weather API snapshot",
  "trigger_pattern": "morning briefing daily summary",
  "tool_chain": [
    { "type": "tool", "tool": "calendar_op", "params": { "action": "list", "limit": 5 } },
    { "type": "tool", "tool": "todo_op", "params": { "action": "list" } },
    { "type": "tool", "tool": "fetch_url", "params": { "url": "https://wttr.in/Moscow?format=j1" } }
  ]
}
```

**Fields:**
- `name` (required) — display name, also used to generate the filename
- `description` — what the workflow does
- `trigger_pattern` — keywords for matching user messages
- `tool_chain` (required) — array of tool and agent steps. Old `{ tool, params }` entries are treated as tool steps.

## Agentic Steps

Workflows can include lightweight workflow-local agent steps. The workflow runtime remains the conductor:

1. Tool steps execute MCP tools.
2. Agent steps receive previous workflow data and return JSON.
3. The runtime validates and stores the agent output.
4. The next step consumes that output.

Agent steps do not execute tools and do not continue the workflow themselves.

Example:
```json
{
  "name": "Agentic Web Research",
  "description": "Fetch a page, let an agent prepare a search, then produce a final answer",
  "trigger_pattern": "agentic web research",
  "tool_chain": [
    {
      "type": "tool",
      "id": "fetch_page",
      "tool": "fetch_url",
      "params": { "url": "{{input.url}}" }
    },
    {
      "type": "agent",
      "id": "prepare_search",
      "agent": "prepare-search",
      "goal": "Analyze the fetched page and produce the best follow-up search params.",
      "input": "{{steps.fetch_page.output}}",
      "required_output": {
        "query": "string",
        "max_results": "number"
      }
    },
    {
      "type": "tool",
      "id": "search",
      "tool": "search_web_bing",
      "params_from": "{{steps.prepare_search.output.next_params}}"
    },
    {
      "type": "agent",
      "id": "final_answer",
      "agent": "final-answer",
      "goal": "Create the final workflow output from the search results.",
      "input": "{{steps.search.output}}",
      "final": true,
      "required_output": {
        "answer": "string",
        "summary": "string",
        "data": "object"
      }
    }
  ]
}
```

Workflow-local agent prompts can live beside folder-based workflows:

```text
agentin/workflows/agentic_web_research/
  workflow.json
  agents/
    prepare-search.md
    final-answer.md
```

If an agent step has no prompt file, the inline `prompt` field or the default workflow-agent instruction is used.

### Agent Step Fields

- `type: "agent"` — marks the step as an agent transform.
- `id` — stable step id for references.
- `agent` — workflow-local prompt name in `agents/<name>.md`.
- `goal` — the local objective.
- `input` — template reference, usually `{{previous.output}}` or `{{steps.some_id.output}}`.
- `required_output` — shape the agent must return.
- `final: true` — marks this output as the workflow final output.
- `llm` — optional compact model override. Omit it to use the app default model.

Example model override:

```json
{
  "type": "agent",
  "id": "cheap_classifier",
  "goal": "Classify whether the previous result needs deeper analysis.",
  "input": "{{previous.output}}",
  "llm": {
    "provider": "ollama",
    "model": "qwen3:latest",
    "on_error": "default"
  },
  "required_output": {
    "next_params": "object"
  }
}
```

`llm.on_error` supports:

- `default` — fallback to the current app default model if the override fails.
- `error` — stop the workflow if the override fails.

Agent outputs are normalized:

- Non-final agent steps return `{ "next_params": ... }` if they did not already include `next_params`.
- Final agent steps return `{ "answer": "...", "summary": "...", "data": {} }`.

Tool steps can consume agent output with `params_from`. If a tool step has no `params` or `params_from`, and the previous agent output has `next_params`, those params are used automatically.

## Available Tools

### `workflow_op`
Unified workflow API with action parameter:
- `list`
- `create`
- `execute`
- `run`
- `get_run`
- `list_runs`
- `copy`
- `delete`

Examples:
```
TOOL:workflow_op{"action":"list"}
TOOL:workflow_op{"action":"create","name":"System Check","tool_chain":[{"tool":"get_stats","params":{}},{"tool":"current_time","params":{}}]}
TOOL:workflow_op{"action":"execute","id":1,"param_overrides":{"search_web_bing":{"query":"new topic"}}}
TOOL:workflow_op{"action":"run","id":1,"mode":"auto"}
TOOL:workflow_op{"action":"get_run","run_id":"workflow-20260409-ab12cd"}
TOOL:workflow_op{"action":"list_runs","limit":10}
TOOL:workflow_op{"action":"copy","source_id":1,"new_name":"System Check Copy"}
TOOL:workflow_op{"action":"delete","id":1}
```

## When to Use

1. **Before multi-tool tasks**: Use `workflow_op` with `action:"list"` to reuse existing workflows
2. **After successful chains**: Suggest saving as a workflow
3. **Copy for variations**: Clone proven workflows and modify them
4. **Manual creation**: Drop a `.json` file into `agentin/workflows/` — it auto-syncs
