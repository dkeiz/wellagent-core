# Skill: Monitoring & Debugging Multi-Agent Systems

## Health Check Protocol

### Check Active Agents
```
TOOL:subagent_op{"action":"list"}
```

Review:
- Status (idle, running, blocked)
- Runtime (how long since spawn)
- Last activity timestamp

### Check Resource Usage
```
TOOL:get_stats{}
TOOL:run_command{"command":"Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 10 ProcessName,WS"}
TOOL:run_command{"command":"Get-PSDrive -PSProvider FileSystem | Select-Object Name,Free,Used"}
```

## Common Issues & Solutions

### Agent Stuck (No Progress)
**Symptoms**: Status=running for >10 min, no output

**Actions**:
1. Check agent's memory log: `read_file("{memory}/tasks/{agent_id}/log.md")`
2. Poll status: `subagent_op{"action":"status","run_id":"..."}`
3. If truly stuck: `subagent_op{"action":"stop","id":X}`
4. Re-spawn with clearer task or more permissions

### Permission Denied
**Symptoms**: Agent reports "tool not available" or "permission denied"

**Actions**:
1. Review original permissions_contract
2. Determine if tool should be safe or unsafe
3. Re-spawn with expanded contract OR
4. Find alternative approach without that tool

### Result Not Returned
**Symptoms**: Agent completed but no data received

**Actions**:
1. Check if `wait=true` was set
2. If not, poll: `subagent_op{"action":"get_run","run_id":"..."}`
3. Check agent's memory output files
4. Search conversation history for agent's final message

### Infinite Spawn Loop
**Symptoms**: Agents spawning agents spawning agents...

**Actions**:
1. `subagent_op{"action":"list"}` to see all
2. Identify root orchestrator
3. Stop chain: `subagent_op{"action":"stop","id":X}` for leaf agents first
4. Add spawn limits to system rules

### Memory Bloat
**Symptoms**: Too many agent logs, disk filling

**Actions**:
1. List agent task directories: `list_directory("{memory}/tasks/")`
2. Archive completed: Move old tasks to `{memory}/archive/`
3. Set auto-cleanup rule (delete tasks >7 days old)

## Audit Trail

For each agent, maintain:
```
{memory}/tasks/{agent_id}/
├── contract.md (permissions granted)
├── log.md (tool calls + results)
├── output.md (final results)
└── metadata.json (spawn time, parent, task)
```

## Debugging Commands

```bash
# List all active agents
subagent_op{"action":"list"}

# Get specific agent status
subagent_op{"action":"status","run_id":"call_123_abc"}

# View agent's conversation
search_conversations{"query":"agent_id_5","limit":50}

# Check permission denials
search_workspace{"query":"permission denied"}

# Review recent spawns
search_conversations{"query":"subagent_op action=new","limit":10}
```

## Recovery Procedures

### Single Agent Failure
1. Stop the agent
2. Review logs for failure cause
3. Fix issue (permissions, task clarity, resources)
4. Re-spawn with corrections

### System-Wide Issue
1. Stop all non-essential agents
2. Check system stats (memory, disk)
3. Review recent changes (rules, tools, prompts)
4. Restart orchestrator (Super Agent)
5. Gradually re-enable agents

### Data Loss Concern
1. Check `{memory}/tasks/` for agent outputs
2. Search conversation history
3. Check workspace files
4. Restore from archive if needed
