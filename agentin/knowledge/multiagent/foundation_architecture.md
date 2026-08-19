# Multi-Agent System Foundation

## Core Architecture

This system supports autonomous multi-agent orchestration. Any LLM can spawn, delegate, and coordinate agents without human intervention.

## Agent Tiers

### Super Agent
- **Purpose**: High-level orchestration, decision-making, spawning other agents
- **Lifespan**: Long-running (session or task-group duration)
- **Permissions**: Broad - can read configs, spawn agents, monitor system
- **Use When**: Complex multi-step tasks, need coordination across domains

### Side Agent
- **Purpose**: Peer collaborator, specialized domain work
- **Lifespan**: Task-bound (completes then terminates)
- **Permissions**: Medium - domain-specific tools only
- **Use When**: Parallel work streams, specialized expertise needed

### Sub Agent
- **Purpose**: Narrow delegated work, focused execution
- **Lifespan**: Short-lived (single task)
- **Permissions**: Minimal - only tools required for specific task
- **Use When**: Isolated subtask, verification, data gathering

### Background Agent
- **Purpose**: Monitoring, automation, trigger-based actions
- **Lifespan**: Persistent (runs until stopped)
- **Permissions**: Restricted - read-only + specific triggers
- **Use When**: Continuous monitoring, scheduled tasks, event listeners

## Permission Model

All agents use `permissions_contract` when spawning:
```json
{
  "safe_tools": ["search_web_bing", "read_file"],
  "unsafe_tools": ["run_command", "delete_file"]
}
```

- **Safe tools**: Auto-granted, low-risk operations
- **Unsafe tools**: Require explicit user approval or super-agent authority

## Communication

Agents communicate via:
1. **Direct delegation** - subagent_op with task handoff
2. **Shared memory** - write to {memory}/tasks/{agent_id}/
3. **Conversation history** - search_conversations for context

## Tool: subagent_op

Primary orchestration tool. Actions:
- `list` - See all active agents
- `run` - Delegate single task
- `run_batch` - Delegate multiple tasks with queuing
- `new` - Create new agent with custom config
- `stop` - Terminate agent

## System Files

- `{agentin}/agents/registry.json` - Active agent registry
- `{memory}/global/multiagent_architecture.md` - User's architecture notes
- `{knowledge}/multiagent/` - This knowledge base
