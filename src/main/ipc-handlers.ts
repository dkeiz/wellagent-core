// @ts-nocheck
const { registerAllHandlers } = require('./ipc/register-all-handlers');

module.exports = function setupIpcHandlers(ipcMain, container) {
  registerAllHandlers(ipcMain, container);
};
