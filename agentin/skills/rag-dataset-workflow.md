# RAG Answer Menu Skill

## Goal
Build a simple support RAG backend from a small list of answers, then run deterministic RAG answers.

## Fast Flow
1. Ingest answer menu entries (issue + instruction).
2. Create a mode with `top_k=1`.
3. Activate `rag_only` mode.
4. Ask questions through `plugin_agent_rag_studio_rag_answer`.
5. Use `-norag` to return to normal agent mode.

## 1) Ingest Menu Entries
```json
TOOL:plugin_agent_rag_studio_dataset{
  "action": "ingest",
  "dataset_id": "ds-tech-support-menu",
  "title": "Tech Support Answers Menu",
  "entries": [
    { "issue": "I forgot my password", "instruction": "Use Reset Password from sign-in page." },
    { "issue": "Two-factor code fails", "instruction": "Sync device time and request a new code." }
  ]
}
```

## 2) Create + Activate Mode
```json
TOOL:plugin_agent_rag_studio_mode{
  "action": "create",
  "mode_id": "mode-tech-support-rag-answer",
  "name": "Tech Support RAG Answer",
  "guidance": "Return one best instruction from dataset.",
  "top_k": 1,
  "min_score": 0.15,
  "dataset_ids": ["ds-tech-support-menu"]
}
```

```json
TOOL:plugin_agent_rag_studio_mode{
  "action": "activate",
  "mode_id": "mode-tech-support-rag-answer"
}
```

## 3) Enable RAG-Only Answers
```json
TOOL:plugin_agent_rag_studio_answer_mode{
  "action": "set",
  "mode": "rag_only"
}
```

## 4) Answer Questions
```json
TOOL:plugin_agent_rag_studio_rag_answer{
  "query": "I forgot my password and cannot sign in"
}
```

## 5) Disable RAG-Only Mode
```json
TOOL:plugin_agent_rag_studio_rag_answer{
  "query": "-norag"
}
```

Or:
```json
TOOL:plugin_agent_rag_studio_answer_mode{
  "action": "set",
  "mode": "agent"
}
```

## Notes
- Use `top_k=1` for deterministic support menus.
- Keep each entry short and unambiguous.
- If answers are weak or mismatched, improve issue wording and re-ingest.
