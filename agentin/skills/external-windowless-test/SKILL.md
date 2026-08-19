# External Windowless Test

Purpose: run full app workflows without opening UI windows.

Start mode:
- `npm run start:test:external`
- Uses `--external-test --windowless --external-port 8788`.

Control API:
- `GET /health` -> returns `ok`, `mode`, `windowCount`.
- `POST /invoke` -> execute IPC channel with args.
- `POST /shutdown` -> stop runtime.

Example workflow:
1. Call `/invoke` `plugins:enable` with `["searxng-search"]`.
2. Call `/invoke` `execute-mcp-tool` for `plugin_searxng_search_search`.
3. Assert `success=true` and non-empty `result.results`.
4. Call `/invoke` `plugins:disable` then `/shutdown`.

Rules:
- Keep test timeout <= 60s.
- Prefer app IPC paths, not standalone mocks.
