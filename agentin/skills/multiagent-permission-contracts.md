# Skill: Building Permission Contracts

## Permission Contract Structure

```json
{
  "safe_tools": ["tool_name_1", "tool_name_2"],
  "unsafe_tools": ["tool_name_3"]
}
```

## Safe vs Unsafe Classification

### Always Safe (low-risk, read-only)
- current_time, calculate, get_stats
- search_web_bing, fetch_url
- read_file (with path restrictions)
- conversation_history, search_conversations
- list_directory, file_exists
- get_current_provider, list_active_rules

### Contextually Safe (depends on paths/scopes)
- write_file (only to {workspace} or {memory}/tasks/)
- edit_file (same restrictions)
- fetch_url (read-only, but external content)

### Always Unsafe (high-risk, system-modifying)
- run_command (shell access)
- delete_file
- create_tool, modify_system_prompt
- connector_op (create/start external services)

## Permission Templates

### Researcher Template
```json
{
  "safe_tools": ["search_web_bing", "fetch_url", "read_file", "write_file"],
  "unsafe_tools": []
}
```

### Analyst Template
```json
{
  "safe_tools": ["read_file", "list_directory", "search_workspace", "calculate", "get_stats"],
  "unsafe_tools": []
}
```

### Developer Template
```json
{
  "safe_tools": ["read_file", "write_file", "list_directory", "search_workspace"],
  "unsafe_tools": ["run_command"]
}
```

### Orchestrator Template (Super Agent)
```json
{
  "safe_tools": ["subagent_op", "workflow_op", "read_file", "write_file", "conversation_history"],
  "unsafe_tools": ["run_command"]
}
```

### Minimal Template (High Security)
```json
{
  "safe_tools": ["search_web_bing", "read_file"],
  "unsafe_tools": []
}
```

## Escalation Patterns

### When Agent Needs More Permissions

1. **Auto-Request** (for safe tools)
   - Agent calls subagent_op to report need
   - Parent evaluates and re-spawns with expanded contract

2. **User Prompt** (for unsafe tools)
   - Agent reports blocked operation
   - System prompts user for approval
   - If approved, operation completes

3. **Fallback** (if denied)
   - Agent reports limitation
   - Parent finds alternative approach
   - Or escalates to higher-tier agent

## Logging Requirements

Always log:
- Agent ID + spawned timestamp
- Permission contract granted
- Tool calls attempted vs completed
- Permission denials (for security audit)

Store at: `{memory}/tasks/{agent_id}/permissions_log.md`
