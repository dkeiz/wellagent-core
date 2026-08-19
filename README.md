# Wellagent Core

**The headless LocalAgent engine — runs anywhere as a CLI, and is the foundation
for the Wellagent desktop GUI.**

Wellagent Core is the complete agent backend extracted from the LocalAgent
monorepo: the superagent runtime, memory, inference, tools, workflows, plugins,
and the HTTP control API. It runs with plain Node (no Electron, no window) and
can be installed as an npm CLI, run from source, or deployed as a Docker
service. The desktop app layers its GUI on top of this same engine.

## Install

```bash
npm install -g wellagent-core
wellagent-core --help
```

Or run without installing:

```bash
npx wellagent-core --port 8788
```

## Quick start

Requirements: Node.js 18+, and one model backend such as Ollama, LM Studio, or
an OpenAI-compatible endpoint.

```bash
npm install
npm run build
npm start
```

Useful commands:

- `npm start` — start the headless agent (control API on `127.0.0.1:8788`).
- `npm run start:cli` — same as `npm start`.
- `npm run nogui` — explicit no-GUI entry (equivalent to the monorepo `-nogui`).

## CLI

```
wellagent-core [options]

  --port, --external-port <n>   Control API port (default 8788)
  --host <host>                 Control API bind host (default 127.0.0.1)
  --data-root <dir>             Runtime data directory (default ./data)
  --db-path <file>              SQLite database path
  --agentin-root <dir>          Agent content root (default ./agentin)
  --user <id>                   Active user id (default localuser)
  --nogui, --noui, --cli        Accepted for compatibility; core is always headless
  -h, --help                    Show help
  -V, --version                 Print version
```

The `--nogui` / `--cli` / `--noui` flags are accepted for parity with the
monorepo; the core is always headless.

## Control API

The running agent exposes an HTTP control API:

- `GET /health` — runtime health check.
- `POST /invoke` — invoke any IPC channel, e.g. `{ "channel": "send-message", "args": [...] }`.
- `POST /shutdown` — graceful shutdown.

```bash
curl http://localhost:8788/health
curl -X POST http://localhost:8788/invoke \
  -H "Content-Type: application/json" \
  -d '{"channel":"get-agents","args":[]}'
```

## Docker

```bash
docker build -t wellagent-core .
docker run --rm -p 8788:8788 wellagent-core
```

Or with Compose (copy `.env.example` to `.env` first):

```bash
docker compose up -d
```

## Environment

- `WELLAGENT_HOST` — control API bind host (default `127.0.0.1`).
- `WELLAGENT_PORT` — control API port (default `8788`).
- `WELLAGENT_DATA_ROOT` — runtime data directory.
- `WELLAGENT_DB_PATH` — SQLite database path.
- `WELLAGENT_AGENTIN_ROOT` — agent content root.
- `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `QWEN_API_KEY` — cloud provider keys.
- `OLLAMA_HOST`, `LMSTUDIO_HOST` — local provider hosts.

## As a foundation for the desktop GUI

This package owns the backend runtime (`dist/src/main`) and the bundled agent
content (`agentin/`). The Wellagent desktop app depends on this package and
provides only the Electron shell and renderer UI, booting the same `cli.ts`
runtime inside its main process.

## Ecosystem

- [Wellagent Desktop](https://github.com/dkeiz/wellagent-desktop) — the graphical app.
- [Wellagent Companion](https://github.com/dkeiz/wellagent-companion) — mobile access.
- [Wellagent Gate](https://github.com/dkeiz/wellagent-gate) — public web gateway.
- [Wellbot](https://github.com/dkeiz/wellbot) — desktop installer CLI.

## License

MIT. See [LICENSE](LICENSE).
