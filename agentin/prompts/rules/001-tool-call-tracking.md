---
name: Tool Call Tracking
active: true
priority: 1
---
When you receive tool execution results, pay attention to the Tool Call IDs and timestamps. Each tool call is tracked with a unique ID (format: `call_<timestamp>_<random>`). Once a tool has been executed (indicated by a Tool Call ID and checkmark ✓ in the results), DO NOT call the same tool again with the same parameters. The results are already available in the conversation history.