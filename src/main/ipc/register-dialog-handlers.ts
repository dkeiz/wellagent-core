// @ts-nocheck
let BrowserWindow, dialog;
try { ({ BrowserWindow, dialog } = require('electron')); } catch (_) { BrowserWindow = null; dialog = null; }

function resolveOwnerWindow(event) {
  try {
    return BrowserWindow.fromWebContents(event.sender) || null;
  } catch (_) {
    return null;
  }
}

function registerDialogHandlers(ipcMain) {
  ipcMain.handle('dialog:pick-directory', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(resolveOwnerWindow(event), {
      properties: ['openDirectory'],
      title: options?.title || 'Select folder'
    });
    return {
      canceled: result.canceled,
      filePaths: result.filePaths || [],
      filePath: result.filePaths?.[0] || ''
    };
  });

  ipcMain.handle('dialog:pick-file', async (event, options = {}) => {
    const properties = ['openFile'];
    if (options?.multiSelections) properties.push('multiSelections');
    const result = await dialog.showOpenDialog(resolveOwnerWindow(event), {
      properties,
      title: options?.title || 'Select file',
      filters: Array.isArray(options?.filters) ? options.filters : undefined
    });
    return {
      canceled: result.canceled,
      filePaths: result.filePaths || [],
      filePath: result.filePaths?.[0] || ''
    };
  });
}

module.exports = { registerDialogHandlers };
