const path = require('path');
const { resolveProjectPath } = require('./runtime-root');
const { startServer } = require('./server-entry');

const args = process.argv.slice(2);
const portArgIdx = args.indexOf('--external-port');
const port = portArgIdx !== -1 && args[portArgIdx + 1]
  ? Number(args[portArgIdx + 1])
  : 8788;

(async () => {
  console.log('[Docker] Starting LocalAgent in headless mode ...');

  const dbPath = resolveProjectPath(__dirname, 'data', 'localagent.db');

  let serverRuntime = null;
  try {
    serverRuntime = await startServer({
      app: null,
      BrowserWindow: null,
      dbPath,
      args: ['--external-test', '--windowless'],
      isTestClientMode: false,
      autoStartDaemons: true,
      enableControlApi: true,
      controlPort: port,
      controlHost: '0.0.0.0',
      shutdownRuntime: async () => {
        if (serverRuntime?.runtime) {
          await serverRuntime.runtime.shutdown();
        }
        process.exit(0);
      }
    });
  } catch (err) {
    console.error('[Docker] Bootstrap failed:', err);
    process.exit(1);
  }

  try {
    console.log(`[Docker] LocalAgent is ready - API at http://0.0.0.0:${port}`);
    console.log('[Docker] Health check: GET /health');
    console.log('[Docker] Send message: POST /invoke  { "channel": "...", "args": [...] }');
  } catch (err) {
    console.error('[Docker] Failed to start HTTP control API:', err);
    process.exit(1);
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      console.log(`[Docker] Received ${signal}, shutting down ...`);
      try {
        await serverRuntime.shutdown();
      } catch (error) {
        console.error('[Docker] Error during shutdown:', error);
      }
      process.exit(0);
    });
  }
})();

export {};
