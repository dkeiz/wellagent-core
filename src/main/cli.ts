#!/usr/bin/env node
// ---------------------------------------------------------------------------
// wellagent-core CLI entrypoint
//
// Boots the agent backend headlessly (no Electron, no window) and exposes the
// HTTP control API. This is the same runtime the monorepo starts with -nogui /
// --cli / Docker mode. It is the foundation the desktop GUI can layer on top of.
// ---------------------------------------------------------------------------

const path = require('path');
const { startServer } = require('./server-entry');

const VERSION = '0.3.0';

function readValue(args: string[], name: string): string | null {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1).trim() || null;
  }
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] && !String(args[index + 1]).startsWith('-')
    ? String(args[index + 1]).trim() || null
    : null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printHelp() {
  console.log(`wellagent-core ${VERSION}

Runs the LocalAgent backend headlessly and exposes the HTTP control API.

Usage:
  wellagent-core [options]

Options:
  --port, --external-port <n>   Control API port (default 8788)
  --host <host>                 Control API bind host (default 127.0.0.1)
  --data-root <dir>             Runtime data directory (default ./data)
  --db-path <file>              SQLite database path (default <data-root>/localagent.db)
  --agentin-root <dir>          Agent content root (default ./agentin)
  --user <id>                   Active user id (default localuser)
  --nogui, --noui, --cli        Accepted for compatibility; core is always headless
  -h, --help                    Show this help
  -V, --version                 Print version

Control API:
  GET  /health                   Runtime health check
  POST /invoke                   Invoke an IPC channel (e.g. send-message)
  POST /shutdown                 Graceful shutdown

Examples:
  wellagent-core
  wellagent-core --port 9000 --host 0.0.0.0
  wellagent-core --data-root /var/lib/wellagent
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = argv;

  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp();
    return;
  }
  if (hasFlag(args, '--version') || hasFlag(args, '-V')) {
    console.log(VERSION);
    return;
  }

  const portArg = readValue(args, '--port') || readValue(args, '--external-port');
  const port = portArg ? Number(portArg) : Number(process.env.WELLAGENT_PORT) || 8788;
  const host = readValue(args, '--host') || process.env.WELLAGENT_HOST || '127.0.0.1';
  const dataRoot = readValue(args, '--data-root') || process.env.WELLAGENT_DATA_ROOT || null;
  const dbPath = readValue(args, '--db-path') || process.env.WELLAGENT_DB_PATH || null;
  const agentinRoot = readValue(args, '--agentin-root') || process.env.WELLAGENT_AGENTIN_ROOT || null;
  const userId = readValue(args, '--user') || null;

  // Accepted for CLI parity with the monorepo; core is always windowless.
  const isNoGui = hasFlag(args, '--nogui') || hasFlag(args, '-nogui')
    || hasFlag(args, '--noui') || hasFlag(args, '-noui')
    || hasFlag(args, '--cli') || hasFlag(args, '--nowindow')
    || hasFlag(args, '--windowless') || hasFlag(args, '-windowless');
  void isNoGui;

  console.log(`[wellagent-core] Starting headless agent (v${VERSION}) ...`);

  let serverRuntime: any = null;
  try {
    serverRuntime = await startServer({
      app: null,
      BrowserWindow: null,
      agentinRoot: agentinRoot || undefined,
      dbPath: dbPath || undefined,
      dataRoot: dataRoot || undefined,
      userId: userId || undefined,
      args: ['--external-test', '--windowless'],
      isTestClientMode: false,
      autoStartDaemons: true,
      enableControlApi: true,
      controlPort: port,
      controlHost: host,
      shutdownRuntime: async () => {
        if (serverRuntime?.runtime) {
          await serverRuntime.runtime.shutdown();
        }
        process.exit(0);
      }
    });
  } catch (error) {
    console.error('[wellagent-core] Bootstrap failed:', error);
    process.exit(1);
  }

  console.log(`[wellagent-core] Ready - control API at http://${host}:${port}`);
  console.log('[wellagent-core] Health check: GET /health');
  console.log('[wellagent-core] Send message: POST /invoke  { "channel": "send-message", "args": [...] }');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      console.log(`[wellagent-core] Received ${signal}, shutting down ...`);
      try {
        await serverRuntime.shutdown();
      } catch (error) {
        console.error('[wellagent-core] Error during shutdown:', error);
      }
      process.exit(0);
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[wellagent-core] Fatal:', error);
    process.exit(1);
  });
}

export {};
