// @ts-nocheck
const { app } = require('electron');
const DatabaseWrapper = require('./database');
const { createUserRegistry } = require('./user-registry');
const { createUserAuth } = require('./user-auth');
const { createSharedWwwGateUserStore } = require('./www-gate-user-store');
const { resolveProjectPath } = require('./runtime-root');

const { createApp, loadConfig } = require(resolveProjectPath(__dirname, 'packages', 'www-gate', 'src', 'index.js'));

let server = null;
let sharedDb = null;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) {
    await new Promise(resolve => server.close(() => resolve()));
    try { server.wwwGate?.store?.close?.(); } catch (_error) {}
    server = null;
  }
  if (sharedDb) {
    try { sharedDb.close(); } catch (_error) {}
    sharedDb = null;
  }
}

async function startWwwGate() {
  await app.whenReady();
  const config = loadConfig();
  sharedDb = new DatabaseWrapper({ app });
  await sharedDb.init();

  const userRegistry = createUserRegistry({ db: sharedDb });
  const activeUser = userRegistry.getDefaultUser();
  const userAuth = createUserAuth({ userRegistry, activeUser });
  const userStore = createSharedWwwGateUserStore({ db: sharedDb, userRegistry, userAuth });

  server = createApp(config, { userStore });
  server.listen(config.port, config.host, () => {
    console.log(`[www-gate] listening on ${config.host}:${config.port} with shared backend users`);
  });

  app.on('before-quit', () => {
    shutdown().catch(() => {});
  });
  process.on('SIGINT', () => {
    shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });

  return { server, sharedDb, userAuth, userRegistry, userStore };
}

if (require.main === module) {
  startWwwGate().catch(error => {
    console.error(`[www-gate] failed to start: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  shutdown,
  startWwwGate
};
