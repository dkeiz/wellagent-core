# Skill: Delegation Patterns

## Pattern 1: Research Pipeline

```
Super Agent
├─ Sub Agent 1: search_web_bing (find sources)
├─ Sub Agent 2: fetch_url (read content)
├─ Sub Agent 3: verify credibility (cross-check)
└─ Super Agent: synthesize results
```

**Use workflow_op** if this pattern repeats.

## Pattern 2: Parallel Exploration

```
Super Agent → run_batch([
  {task: "Find pros of approach A"},
  {task: "Find pros of approach B"},
  {task: "Find cons of approach A"},
  {task: "Find cons of approach B"}
])
→ Aggregate results → Decision
```

## Pattern 3: Verify Then Act

```
Agent 1: Propose solution
Agent 2: Review/critique (different model if possible)
Agent 3: Implement if approved
Super Agent: Final validation
```

## Pattern 4: Monitor + Alert

```
Background Agent: Continuous monitoring
├─ Check condition every N minutes
├─ If triggered → notify Super Agent
└─ Super Agent → spawn Sub Agent for response
```

## Pattern 5: Escalation Chain

```
Sub Agent (limited permissions)
  └─ Blocked → reports to Side Agent
      └─ Can't resolve → reports to Super Agent
          └─ Unsafe operation → prompts User
```

## Pattern 6: Handoff with Context

```python
# Agent 1 completes research, writes to memory
write_file("{memory}/tasks/research_result.md", findings)

# Agent 2 reads and continues
read_file("{memory}/tasks/research_result.md")
```

## Anti-Patterns to Avoid

❌ **Spawn without clear task** - "Go do something useful"
✅ **Specific delegation** - "Find 3 sources about X, return URLs"

❌ **Over-permission** - Giving all tools "just in case"
✅ **Minimal permissions** - Only what task requires

❌ **No completion criteria** - Agent doesn't know when done
✅ **Clear success definition** - "Return when you have 3 sources"

❌ **Circular delegation** - Agent A spawns B spawns A
✅ **Tree structure** - Clear parent-child hierarchy

❌ **No result aggregation** - Spawned agents, forgot to collect
✅ **Explicit collection** - Wait=true or poll status

## Context Window Management

When your context is getting full:
1. Spawn Sub Agent for next steps
2. Write current state to memory
3. Let Sub Agent continue from memory
4. Collect final result only

This keeps your context lean while work continues.
