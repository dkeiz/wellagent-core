# A2A Interoperability Skill

Use this skill when work involves LocalAgent A2A exposure or calling external agent-like systems.

## Rules
- Prefer A2A when the target is a real A2A peer.
- Prefer provider or HTTP bridges when the target already has a stable API.
- Use plain CLI bridges only when no better protocol exists.

## LocalAgent Surfaces
- A2A exposure is controlled from standard settings.
- `a2a_op` is the MCP tool for target discovery and invocation.
- Knowledge for concrete targets lives under `agentin/knowledge/library/interop-*`.

## Target Choice
- Codex: provider bridge through OpenAI routing.
- LM Studio: provider bridge through the existing LM Studio adapter.
- ComfyUI: workflow HTTP bridge.
- Future coding tools: CLI bridge unless they expose a stronger contract.
