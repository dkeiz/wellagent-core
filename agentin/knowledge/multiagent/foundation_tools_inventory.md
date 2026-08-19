# Tool Inventory for Multi-Agent Orchestration

## Orchestration Tools

### subagent_op
**Purpose**: Spawn and manage agents
**Key Parameters**:
- `action`: list | run | run_batch | new | stop | status
- `id`: Agent ID (prefer over name)
- `task`: Focused task description
- `permissions_contract`: { safe_tools: [], unsafe_tools: [] }
- `subagent_mode`: "ui" (visible) | "no_ui" (background)
- `wait`: true/false - wait for completion

**When to Use**:
- Task can be isolated with clear input/output
- Need parallel execution
- Specialized expertise required
- Risk isolation needed

### workflow_op
**Purpose**: Execute reusable tool chains
**Key Parameters**:
- `action`: list | execute | run | create
- `id`: Workflow ID
- `param_overrides`: Tool parameter overrides

**When to Use**:
- Repeated patterns (research → verify → summarize)
- Standardized processes
- Quality control workflows

### connector_op
**Purpose**: External service integrations
**Key Parameters**:
- `action`: create | start | stop | list | config_get | config_set
- `name`: Connector name
- `code`: Connector source (for create)

**When to Use**:
- Need external API access
- Background monitoring
- Event-driven triggers

## Memory Tools

### read_file / write_file
**Purpose**: Shared state between agents
**Path Tokens**: {memory}, {knowledge}, {workspace}

### conversation_history / search_conversations
**Purpose**: Context sharing, audit trail

## System Tools

### get_stats
**Purpose**: Monitor system usage, agent activity

### list_active_rules
**Purpose**: Check behavioral constraints

### get_current_provider
**Purpose**: Know which model is running (for capability awareness)

## Tool Capability Groups

| Group | Tools | Typical Agent Access |
|-------|-------|---------------------|
| ⚙️ System | current_time, calculate, get_stats | All agents |
| 🤖 Agent | conversation_history, calendar, todos, subagent_op | Super/Side only |
| 🌐 Web | search_web_bing, fetch_url | Most agents |
| 📁 Files | read_file, write_file, list_directory | Configurable |
| 💻 Terminal | run_command | Restricted (unsafe) |
| 🎬 Media | image, open_media, screenshot | Task-specific |
| 🔴 Unsafe | create_tool, modify_system_prompt | Super agents only |
