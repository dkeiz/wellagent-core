# Skill: Agent Selection Decision Tree

## Quick Decision Flow

```
Task arrives
├─ Can it be done in one tool call?
│  └─ YES → Do it yourself, no agent needed
│  └─ NO → Continue
├─ Does it require parallel execution?
│  └─ YES → Use run_batch with multiple sub-agents
│  └─ NO → Continue
├─ Is it high-risk (file delete, command run, system modify)?
│  └─ YES → Spawn Sub Agent with restricted permissions OR ask user
│  └─ NO → Continue
├─ Will it take >5 tool calls?
│  └─ YES → Delegate to Sub Agent
│  └─ NO → Do it yourself
├─ Does it need specialized expertise?
│  └─ YES → Spawn Side Agent with domain permissions
│  └─ NO → Continue
├─ Is it ongoing monitoring/automation?
│  └─ YES → Spawn Background Agent with triggers
│  └─ NO → Continue
└─ Is it coordinating multiple agents?
   └─ YES → You are Super Agent, spawn others
   └─ NO → Do it yourself
```

## Agent Type Selection

### Choose Sub Agent When:
- Single focused task ("find 3 sources about X")
- Need isolation for safety
- Task has clear completion criteria
- Want to free your context window

**Permission Pattern**:
```json
{"safe_tools": ["search_web_bing", "read_file"], "unsafe_tools": []}
```

### Choose Side Agent When:
- Parallel work stream ("you handle research, I'll handle writing")
- Domain expertise needed (code review, legal analysis)
- Equal collaboration, not hierarchy

**Permission Pattern**:
```json
{"safe_tools": ["search_web_bing", "read_file"], "unsafe_tools": ["run_command"]}
```

### Choose Background Agent When:
- Continuous monitoring ("watch for file changes")
- Scheduled tasks ("check weather every 6 hours")
- Event-driven triggers ("notify when API responds")

**Permission Pattern**:
```json
{"safe_tools": ["read_file", "get_stats"], "unsafe_tools": []}
```

### Act as Super Agent When:
- Coordinating 3+ agents
- Making high-level decisions
- Need to monitor multiple task streams
- Aggregating results from others

**Permission Pattern**:
```json
{"safe_tools": ["*"], "unsafe_tools": ["run_command", "delete_file"]}
```

## Task Description Best Practices

**Bad**: "Do research"
**Good**: "Find 3 reliable sources about Python async patterns from 2024-2026. Return URLs and 1-sentence summaries."

**Bad**: "Check the files"
**Good**: "List all .md files in {knowledge}/multiagent/, read each, extract key concepts as bullet points."

Include:
1. Clear success criteria
2. Expected output format
3. Tool constraints (if any)
4. Deadline/urgency (if relevant)
