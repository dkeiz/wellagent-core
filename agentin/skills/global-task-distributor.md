# Global Task Distributor

## Purpose
Use one global queue file as the only state for deferred and distributable tasks:
- Queue file: `agentin/tasks/tasks.md`
- Listeners: `chat`, `daemon`
- Database is logger only (events), not state

## Queue Markers
Only edit lines between:
- `<!-- TASK_QUEUE:BEGIN -->`
- `<!-- TASK_QUEUE:END -->`

## Task Line Format
One task per line:

`- [ ] id:T-... | status:pending | listener:chat | owner:none | run_id:none | requires_user_action:1 | priority:normal | dedupe:key | action:chat.request_decision | payload:{} | title:... | by:agent-name | at:2026-...Z | run_after:none`

Fields:
- `id`: stable task id
- `status`: lifecycle state
- `listener`: `chat` or `daemon`
- `owner`: claimant (`none` before claim)
- `run_id`: claim token (`none` before claim)
- `requires_user_action`: `0` or `1`
- `priority`: `low|normal|high`
- `dedupe`: idempotency key
- `action`: executable action hint
- `payload`: JSON object
- `title`: short task label
- `by`: creator
- `at`: created timestamp ISO
- `run_after`: defer timestamp ISO or `none`

## Status Contract
Active:
- `pending`
- `awaiting_user`
- `approved`
- `running`
- `deferred`

Terminal:
- `done`
- `failed`
- `cancelled`

## Claim + Handoff Rules
1. Listener claims task by setting:
- `status:running`
- `owner:<listener-or-agent>`
- `run_id:<token>`

2. Executor may create local/internal jobs if needed.

3. Keep global task linked until final result:
- `done` when complete
- `failed` on hard error
- `deferred` with future `run_after` when delayed

4. Do not close global task immediately on local enqueue unless local enqueue is the intended completion action.

## Listener Selection
Use `listener:chat` when:
- user decision is required
- immediate interactive follow-up is expected
- optional subagent delegation depends on user confirmation

Use `listener:daemon` when:
- background work is acceptable
- delayed execution is acceptable
- work should resume after busy/preempt/resource blocks

## Dedupe Rule
Always set `dedupe` for recurring triggers.
If non-terminal task with same `dedupe` exists:
- reuse/update existing task
- do not create duplicates

## Action Conventions (v1)
- `chat.request_decision`: prompt user for run/delegate/defer
- `subagent.delegate`: payload includes delegation params
- `daemon.enqueue_memory_job`: daemon should enqueue internal memory job

## Examples
Ask user first:
`- [ ] id:T-... | status:awaiting_user | listener:chat | owner:none | run_id:none | requires_user_action:1 | priority:normal | dedupe:mail:check:today | action:chat.request_decision | payload:{"question":"Check inbox now?"} | title:Check email inbox | by:assistant | at:2026-...Z | run_after:none`

Delegate through subagent:
`- [ ] id:T-... | status:approved | listener:chat | owner:none | run_id:none | requires_user_action:0 | priority:normal | dedupe:research:x | action:subagent.delegate | payload:{"subagentId":5,"task":"Find 3 sources for X"} | title:Delegate research X | by:user | at:2026-...Z | run_after:none`

Daemon defer flow:
`- [ ] id:T-... | status:deferred | listener:daemon | owner:daemon | run_id:daemon-... | requires_user_action:0 | priority:normal | dedupe:daemon:summarize:412 | action:daemon.enqueue_memory_job | payload:{"jobType":"summarize_session","sessionId":"412"} | title:Summarize closed session 412 | by:agent-loop | at:2026-...Z | run_after:2026-...Z`

## Safety
- Do not edit outside queue markers.
- Keep `payload` valid JSON.
- Prefer updating an existing deduped task over creating new lines.
- Never fabricate completion; only set `done` after actual execution.
