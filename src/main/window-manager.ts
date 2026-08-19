import path = require('path');

export interface WindowManagerOptions {
  BrowserWindow?: any;
  rendererPath?: string | null;
  createWindow?: ((options?: { kind?: string; options?: any }) => any) | null;
}

const MAIN_WINDOW_OPTIONS = {
  width: 1400,
  height: 900,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false,
    preload: path.join(__dirname, '../renderer/electron-api.js')
  },
  titleBarStyle: 'default',
  show: true
};

const AUX_WINDOW_OPTIONS = {
  width: 1200,
  height: 800,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false,
    preload: path.join(__dirname, '../renderer/electron-api.js')
  },
  show: false
};

export function createElectronWindowFactory({ BrowserWindow, rendererPath }: { BrowserWindow: any; rendererPath?: string | null }) {
  if (!BrowserWindow) {
    throw new Error('BrowserWindow is required to create Electron windows');
  }

  const resolvedRendererPath = rendererPath || path.join(__dirname, '../renderer/index.html');

  return ({ kind = 'main', options = {} as any } = {} as any) => {
    const defaults = kind === 'main' ? MAIN_WINDOW_OPTIONS : AUX_WINDOW_OPTIONS;
    const windowOptions = {
      ...defaults,
      ...options,
      webPreferences: {
        ...defaults.webPreferences,
        ...(options.webPreferences || {})
      }
    };
    const win = new BrowserWindow(windowOptions);

    if (typeof win.loadFile === 'function') {
      win.loadFile(resolvedRendererPath);
    }

    if (windowOptions.show === false && typeof win.once === 'function' && typeof win.show === 'function') {
      win.once('ready-to-show', () => win.show());
    }

    return win;
  };
}

export function createStaticWindowManager(windowLike = null) {
  let currentWindow = windowLike;

  return {
    setMainWindow(windowRef: any) {
      currentWindow = windowRef || null;
      return currentWindow;
    },
    clearMainWindow() {
      currentWindow = null;
    },
    getMainWindow() {
      return currentWindow;
    },
    hasMainWindow() {
      return Boolean(currentWindow);
    },
    send(channel: string, payload: any) {
      if (!currentWindow?.webContents?.send) return false;
      try {
        currentWindow.webContents.send(channel, payload);
        return true;
      } catch (_error) {
        return false;
      }
    }
  };
}

export class WindowManager {
  private _createWindow: (options?: { kind?: string; options?: any }) => any;
  private _mainWindow: any;

  constructor({ BrowserWindow = null, rendererPath = null, createWindow = null }: WindowManagerOptions = {}) {
    this._createWindow = createWindow || createElectronWindowFactory({ BrowserWindow, rendererPath });
    this._mainWindow = null;
  }

  createMainWindow(options = {}) {
    const win = this._createWindow({ kind: 'main', options });
    return this.setMainWindow(win);
  }

  openAuxWindow(options = {}) {
    return this._createWindow({ kind: 'aux', options });
  }

  setMainWindow(win: any) {
    this._mainWindow = win || null;

    if (win && typeof win.on === 'function') {
      win.on('closed', () => {
        if (this._mainWindow === win) {
          this._mainWindow = null;
        }
      });
    }

    return win;
  }

  clearMainWindow(windowRef = null) {
    if (windowRef && this._mainWindow !== windowRef) {
      return;
    }
    this._mainWindow = null;
  }

  getMainWindow() {
    const win = this._mainWindow;
    if (!win) return null;

    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
      this._mainWindow = null;
      return null;
    }

    return win;
  }

  hasMainWindow() {
    return Boolean(this.getMainWindow());
  }

  send(channel: string, payload: any) {
    const win = this.getMainWindow();
    if (!win?.webContents?.send) return false;

    try {
      win.webContents.send(channel, payload);
      return true;
    } catch (_error) {
      return false;
    }
  }
}
