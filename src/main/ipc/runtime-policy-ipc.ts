// @ts-nocheck
function createPolicyIpcMain(ipcMain, runtime = {}) {
  const runtimePolicy = runtime.runtimePolicy || runtime.container?.optional?.('runtimePolicy') || null;
  if (!ipcMain?.handle || !runtimePolicy?.assert) {
    return ipcMain;
  }

  return {
    ...ipcMain,
    handle(channel, handler) {
      return ipcMain.handle(channel, async (event, ...args) => {
        runtimePolicy.assert({
          principal: runtimePolicy.createRendererIpcPrincipal
            ? runtimePolicy.createRendererIpcPrincipal(channel)
            : { type: 'renderer', id: `renderer:ipc:${channel}`, profile: 'renderer-ipc' },
          action: 'ipc.invoke',
          resource: channel,
          metadata: {
            channel,
            senderId: event?.sender?.id ?? null,
            frameUrl: event?.senderFrame?.url || event?.frame?.url || ''
          }
        });
        const userAuth = runtime.userAuth || runtime.container?.optional?.('userAuth') || null;
        if (userAuth?.createElectronRequestContext) {
          event.requestContext = userAuth.createElectronRequestContext();
        }
        return handler(event, ...args);
      });
    },
    removeHandler(channel) {
      return ipcMain.removeHandler?.(channel);
    }
  };
}

module.exports = {
  createPolicyIpcMain
};
