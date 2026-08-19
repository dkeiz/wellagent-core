# SearXNG Plugin Backend

Purpose: keep search implementation inside plugin lifecycle.

Plugin behavior:
- Registers `discover`, `search`, `server_status` tools on enable.
- Starts local proxy server when `enableLocalServer=true`.
- Stops proxy and backend on disable.

Backend modes:
- `backendMode=embedded`: plugin starts its own backend process.
- `backendMode=remote`: plugin targets configured remote/base URL.

Embedded backend config:
- `backendAutoStart`
- `backendCommand`
- `backendArgs`
- `backendWorkingDir`
- `backendBaseUrl`
- `backendHealthPath`
- `backendStartupTimeoutMs`

Search behavior:
- Try configured/discovered SearXNG first.
- If blocked, fallback engine can return real web results.
