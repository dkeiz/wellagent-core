// @ts-nocheck
export interface DeferredStartupOptions {
  db: any;
  startupProfiler: any;
  memoryDaemon: any;
  workflowScheduler: any;
  isTestClientMode: boolean;
  isExternalTestMode: boolean;
  isSkinTestMode: boolean;
  isNoWindowMode: boolean;
  startCompanionServerFromSettings: () => Promise<void>;
  remoteGatewayManager: any;
  getRemoteGatewaySecret: (db: any, options?: any) => Promise<string | null>;
  scopeOptions?: any;
}

export interface DeferredRuntime {
  schedule(options?: { autoStartBackground?: boolean }): Promise<void>;
  shutdown(options: { container: any }): Promise<void>;
}

function scheduleNamedStartup(taskName: string, startupProfiler: any, task: () => Promise<void>): void {
  setTimeout(() => {
    startupProfiler.time(taskName, task).catch((error: any) => {
      console.error(`[Bootstrap] ${taskName} failed:`, error?.message || error);
    });
  }, 0);
}

function createDeferredRuntimeStartup({
  db,
  startupProfiler,
  memoryDaemon,
  workflowScheduler,
  isTestClientMode,
  isExternalTestMode,
  isSkinTestMode,
  isNoWindowMode,
  startCompanionServerFromSettings,
  remoteGatewayManager,
  getRemoteGatewaySecret,
  scopeOptions = { userId: 'localuser' }
}: DeferredStartupOptions): DeferredRuntime {
  let companionStartupPromise: Promise<void> | null = null;
  let companionStartupCanceled = false;

  return {
    async schedule({ autoStartBackground = true } = {}) {
      const companionEnabled = await db.getScopedSetting('companion.enabled', scopeOptions);
      if (companionEnabled === 'true') {
        setTimeout(() => {
          if (companionStartupCanceled) return;
          companionStartupPromise = startCompanionServerFromSettings().finally(() => {
            companionStartupPromise = null;
          });
        }, 0);
      }

      if (await db.getScopedSetting('remoteGateway.enabled', scopeOptions) === 'true') {
        scheduleNamedStartup('remoteGateway.connect', startupProfiler, async () => {
          const url = await db.getScopedSetting('remoteGateway.url', scopeOptions);
          const secret = await getRemoteGatewaySecret(db, scopeOptions);
          if (!url || !secret) return;
          await remoteGatewayManager.connect(url, secret, scopeOptions);
        });
      }

      const isAnyTestMode = isTestClientMode || isExternalTestMode || isSkinTestMode || isNoWindowMode;
      if (autoStartBackground && !isAnyTestMode) {
        scheduleNamedStartup('memoryDaemon.start', startupProfiler, () => memoryDaemon.start());
        scheduleNamedStartup('workflowScheduler.start', startupProfiler, () => workflowScheduler.start());
      }
    },

    async shutdown({ container }) {
      companionStartupCanceled = true;
      if (companionStartupPromise) {
        await companionStartupPromise.catch(() => null);
      }

      const pluginMgr = container.optional('pluginManager');
      const memorySvc = container.optional('memoryDaemon');
      const workflowSvc = container.optional('workflowScheduler');
      const timerSvc = container.optional('timerManager');
      const loopSvc = container.optional('agentLoop');
      const managerSvc = container.optional('agentManager');
      const connectorSvc = container.optional('connectorRuntime');
      const a2aSvc = container.optional('a2aManager');
      const companionGatewaySvc = container.optional('companionServer');
      const remoteGatewaySvc = container.optional('remoteGatewayManager');
      const portSvc = container.optional('portListenerManager');
      const promptSvc = container.optional('promptFileManager');
      const mcpSvc = container.optional('mcpServer');
      const dbSvc = container.optional('db');

      if (pluginMgr) await pluginMgr.disableAll({ persistStatus: false });
      if (memorySvc) memorySvc.stop();
      if (workflowSvc) workflowSvc.stop();
      if (timerSvc) timerSvc.stop();
      if (loopSvc) await loopSvc.onAppQuit();
      if (managerSvc) await managerSvc.onAppQuit();
      if (connectorSvc) await connectorSvc.stopAll();
      if (a2aSvc) await a2aSvc.shutdown();
      if (companionGatewaySvc) await companionGatewaySvc.stop();
      if (remoteGatewaySvc) remoteGatewaySvc.disconnect();
      if (portSvc) await portSvc.stopAll();
      if (promptSvc) promptSvc.stopWatching();
      if (mcpSvc) await mcpSvc.stop();
      if (dbSvc) await dbSvc.close();
    }
  };
}

module.exports = {
  createDeferredRuntimeStartup,
  scheduleNamedStartup
};


