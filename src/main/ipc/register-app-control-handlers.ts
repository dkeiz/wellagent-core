// @ts-nocheck
let app, BrowserWindow, shell;
try { ({ app, BrowserWindow, shell } = require('electron')); } catch (_) { app = null; BrowserWindow = null; shell = null; }
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { resolvePathTokens } = require('../path-tokens');
const { readTypefaceList } = require('../ui-typefaces');
const { createDesktopAccountService } = require('../desktop-account-service');
const { ScreenshotCaptureService } = require('../screenshot-capture-service');

function resolveOwnerWindow(event) {
  try {
    return BrowserWindow.fromWebContents(event.sender) || null;
  } catch (_) {
    return null;
  }
}

function normalizeValue(rawValue) {
  return String(rawValue || '').trim();
}

function resolveActiveWindow(event, runtime = {}) {
  return resolveOwnerWindow(event) || runtime.windowManager?.getMainWindow?.() || null;
}

function listAppWindows() {
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
    return [];
  }
  return BrowserWindow.getAllWindows()
    .filter((windowRef) => windowRef && !windowRef.isDestroyed?.())
    .map((windowRef) => {
      let url = '';
      try {
        url = String(windowRef.webContents?.getURL?.() || '');
      } catch (_) {}
      let title = '';
      try {
        title = String(windowRef.getTitle?.() || windowRef.webContents?.getTitle?.() || '');
      } catch (_) {}
      let bounds = null;
      try {
        bounds = windowRef.getBounds?.() || null;
      } catch (_) {}
      return {
        id: Number(windowRef.id || 0) || null,
        title,
        url,
        isFocused: Boolean(windowRef.isFocused?.()),
        isVisible: Boolean(windowRef.isVisible?.()),
        isMinimized: Boolean(windowRef.isMinimized?.()),
        bounds
      };
    });
}

function resolveWindowById(windowId, event, runtime = {}) {
  const normalizedId = Number(windowId || 0);
  if (normalizedId > 0 && BrowserWindow && typeof BrowserWindow.fromId === 'function') {
    const windowRef = BrowserWindow.fromId(normalizedId);
    if (windowRef && !windowRef.isDestroyed?.()) {
      return windowRef;
    }
  }
  return resolveActiveWindow(event, runtime);
}

async function captureWindowToFile(windowRef, outputPath = '', captureService = null) {
  if (!windowRef?.webContents?.capturePage) {
    return { success: false, error: 'Window capture is unavailable' };
  }
  try {
    const targetPath = String(outputPath || '').trim()
      || path.join(os.tmpdir(), `localagent-capture-${Date.now()}.png`);
    const service = captureService || new ScreenshotCaptureService();
    const captured = await service.capture({ target: 'self', sourceId: String(windowRef.id || '') });
    await service.writePng(captured.image, targetPath);
    return {
      success: true,
      windowId: Number(windowRef.id || 0) || null,
      path: targetPath,
      width: captured.width || null,
      height: captured.height || null
    };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

async function inspectRenderer(windowRef) {
  if (!windowRef?.webContents?.executeJavaScript) {
    return { success: false, error: 'Renderer inspection is unavailable' };
  }
  try {
    const result = await windowRef.webContents.executeJavaScript(`(() => {
      const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const stripHtml = (value) => String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const chatTabs = window.mainPanel?.chatTabs instanceof Map
        ? Array.from(window.mainPanel.chatTabs.entries()).map(([id, tab]) => ({
            id: String(id || ''),
            title: String(tab?.title || ''),
            messageText: stripHtml(tab?.messagesHTML || '').slice(-4000)
          }))
        : [];
      const activeTabId = String(window.mainPanel?.activeTabId || '');
      const activeChatTab = chatTabs.find(tab => tab.id === activeTabId) || null;
      const providerSelect = document.getElementById('llm-provider-select');
      const modelSelect = document.getElementById('llm-model-select');
      const shardRuntime = window.__localAgentShardRuntime && typeof window.__localAgentShardRuntime.getState === 'function'
        ? window.__localAgentShardRuntime.getState()
        : (window.__localAgentShardRuntime?.state || null);
      return {
        title: document.title || '',
        bodyText,
        bodyTextSample: bodyText.slice(0, 4000),
        location: String(window.location || ''),
        readyState: document.readyState || '',
        shardRuntime,
        activeTabId,
        sidebarSessionId: String(window.sidebar?.currentSessionId || ''),
        selectedProvider: String(providerSelect?.value || ''),
        selectedModel: String(modelSelect?.value || ''),
        selectedModelLabel: String(modelSelect?.selectedOptions?.[0]?.textContent || ''),
        activeChatTab,
        chatTabs
      };
    })()` , true);
    return { success: true, ...(result && typeof result === 'object' ? result : {}) };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

function getAvailableProfiles(runtime = {}) {
  if (typeof runtime.profileSwitcher?.listProfiles === 'function') {
    return runtime.profileSwitcher.listProfiles();
  }
  if (typeof runtime.profileRegistry?.listProfiles === 'function') {
    return runtime.profileRegistry.listProfiles();
  }
  return [];
}

function getSelectedProfile(runtime = {}) {
  if (typeof runtime.profileRegistry?.getActiveNamedProfile === 'function') {
    return runtime.profileRegistry.getActiveNamedProfile();
  }
  if (typeof runtime.profileRegistry?.getActiveProfile === 'function') {
    const activeProfile = runtime.profileRegistry.getActiveProfile();
    return activeProfile?.userId === 'localuser' ? null : activeProfile;
  }
  if (typeof runtime.profileSwitcher?.getActiveProfile === 'function') {
    return runtime.profileSwitcher.getActiveProfile();
  }
  return runtime.activeProfile || null;
}

function getSelectedProfileId(runtime = {}) {
  if (typeof runtime.profileRegistry?.getActiveProfileId === 'function') {
    return runtime.profileRegistry.getActiveProfileId();
  }
  return getSelectedProfile(runtime)?.userId || null;
}

function annotateProfiles(profiles = [], currentProfileId = null, selectedProfileId = null) {
  return profiles.map((profile) => ({
    ...profile,
    isCurrent: Boolean(profile?.userId && profile.userId === currentProfileId),
    isSelected: Boolean(profile?.userId && profile.userId === selectedProfileId)
  }));
}

function buildProfileState(runtime = {}) {
  const currentProfile = runtime.profileRegistry?.getProfile?.(getActiveUser(runtime)?.userId) || runtime.activeProfile || null;
  const currentProfileId = currentProfile?.userId || null;
  const selectedProfile = getSelectedProfile(runtime);
  const selectedProfileId = selectedProfile?.userId || currentProfileId || null;
  const requiresRestart = false;

  return {
    success: true,
    profiles: annotateProfiles(getAvailableProfiles(runtime), currentProfileId, selectedProfileId),
    currentProfile,
    currentProfileId,
    selectedProfile,
    selectedProfileId,
    requiresRestart,
    restartOptions: null
  };
}

function getProfileServices(runtime = {}) {
  return {
    profileRegistry: runtime.profileRegistry || null,
    profileSwitcher: runtime.profileSwitcher || null
  };
}

function getAvailableUsers(runtime = {}) {
  if (typeof runtime.userAuth?.listUsers === 'function') {
    return runtime.userAuth.listUsers();
  }
  if (typeof runtime.userRegistry?.listUsers === 'function') {
    return runtime.userRegistry.listUsers();
  }
  return runtime.activeUser ? [runtime.activeUser] : [];
}

function getActiveUser(runtime = {}) {
  if (typeof runtime.userAuth?.getActiveUser === 'function') {
    return runtime.userAuth.getActiveUser();
  }
  return runtime.activeUser || null;
}

function annotateUsers(users = [], activeUserId = null) {
  return users.map((user) => ({
    ...user,
    isActive: Boolean(user?.userId && user.userId === activeUserId)
  }));
}

function buildUserState(runtime = {}) {
  const activeUser = getActiveUser(runtime);
  const activeUserId = activeUser?.userId || null;
  return {
    success: true,
    users: annotateUsers(getAvailableUsers(runtime), activeUserId),
    activeUser,
    activeUserId
  };
}

function getUserServices(runtime = {}) {
  return {
    userRegistry: runtime.userRegistry || null,
    userAuth: runtime.userAuth || null
  };
}

function buildRelaunchArgs(argv = process.argv.slice(1), options = {}) {
  const nextArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '').trim();
    if (!value) {
      continue;
    }
    if (value.startsWith('--profile=')) {
      continue;
    }
    if (value === '--profile') {
      index += 1;
      continue;
    }
    nextArgs.push(argv[index]);
  }


  return nextArgs;
}

function registerAppControlHandlers(ipcMain, runtime = {}) {
  const screenshotCaptureService = new ScreenshotCaptureService({ windowManager: runtime.windowManager || null });
  const accountService = runtime.userRegistry && runtime.userAuth && runtime.agentManager
    ? createDesktopAccountService(runtime)
    : null;

  function normalizeLocalPath(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return '';
    if (!value.startsWith('file://')) return value;

    try {
      const parsed = new URL(value);
      const decodedPath = decodeURIComponent(parsed.pathname || '');
      if (parsed.hostname && parsed.hostname !== 'localhost') {
        return `\\${parsed.hostname}${decodedPath.replace(/\//g, '\\')}`;
      }
      return decodedPath.replace(/^\/([a-zA-Z]:)/, '$1');
    } catch (_) {
      return value.replace(/^file:\/\/+/, '');
    }
  }

  async function resolveLocalPath(event, rawValue, options = {}) {
    const requestedPath = normalizeLocalPath(rawValue);
    if (!requestedPath) {
      return { success: false, error: 'Invalid local path' };
    }
    const requestContext = runtime.requestContextService?.normalizeRequestContext
      ? runtime.requestContextService.normalizeRequestContext(event?.requestContext || {})
      : (event?.requestContext || {});
    const dbScope = { requestContext, userId: requestContext.userId || null };
    const requestedSessionId = String(options?.sessionId || options?.sourceSessionId || '').trim();
    let session = requestedSessionId && runtime.db?.getChatSessionById
      ? await runtime.db.getChatSessionById(requestedSessionId, dbScope)
      : null;
    if (!session && runtime.db?.getCurrentSession) {
      session = await runtime.db.getCurrentSession(dbScope);
    }
    const sessionId = (session?.id ?? requestedSessionId) || null;
    const agentId = options?.agentId ?? options?.sourceAgentId ?? session?.agent_id ?? null;
    const resolvedPath = await resolvePathTokens(requestedPath, {
      agentManager: runtime.agentManager || null,
      sessionWorkspace: runtime.sessionWorkspace || null,
      executionDirectory: runtime.executionDirectory || null,
      sessionId,
      agentId,
      context: {
        sessionId,
        agentId,
        requestContext,
        userId: requestContext.userId || null
      }
    });
    if (/\{[a-z_]+\}/i.test(resolvedPath)) {
      return {
        success: false,
        error: `Cannot resolve path token for this viewer tab: ${requestedPath}`
      };
    }
    const absolutePath = path.resolve(resolvedPath);
    return {
      success: true,
      requestedPath,
      path: absolutePath,
      url: pathToFileURL(absolutePath).href,
      sessionId: sessionId ? String(sessionId) : null,
      agentId: agentId ?? null
    };
  }

  ipcMain.handle('app:capture-main-window', async (event, options = {}) => {
    const activeWindow = resolveActiveWindow(event, runtime);
    if (!activeWindow) {
      return { success: false, error: 'No active window to capture' };
    }
    return captureWindowToFile(activeWindow, options?.path || '', screenshotCaptureService);
  });

  ipcMain.handle('app:capture-window', async (event, options = {}) => {
    const targetWindow = resolveWindowById(options?.windowId, event, runtime);
    if (!targetWindow) {
      return { success: false, error: 'No target window to capture' };
    }
    return captureWindowToFile(targetWindow, options?.path || '', screenshotCaptureService);
  });

  ipcMain.handle('app:list-windows', async () => ({
    success: true,
    windows: listAppWindows()
  }));

  ipcMain.handle('app:get-runtime-context', async () => ({
    success: true,
    runtime: runtime.runtimeUiContext || null
  }));

  ipcMain.handle('app:inspect-renderer', async (event) => {
    const activeWindow = resolveActiveWindow(event, runtime);
    if (!activeWindow) {
      return { success: false, error: 'No active window to inspect' };
    }
    return inspectRenderer(activeWindow);
  });

  ipcMain.handle('app:load-session-into-ui', async (event, sessionId) => {
    const activeWindow = resolveActiveWindow(event, runtime);
    if (!activeWindow?.webContents?.executeJavaScript) {
      return { success: false, error: 'No active window to control' };
    }
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    try {
      const result = await activeWindow.webContents.executeJavaScript(`(async () => {
        const raw = ${JSON.stringify('__SESSION_ID__')};
        const sessionId = /^\d+$/.test(raw) ? Number(raw) : raw;
        if (window.sidebar?.loadSession) {
          await window.sidebar.loadSession(sessionId);
        } else if (window.mainPanel?.switchTab) {
          if (!window.mainPanel.chatTabs?.has(sessionId)) {
            window.mainPanel.chatTabs?.set?.(sessionId, { title: 'Chat', messagesHTML: '', followOutput: true, scrollTop: 0, needsReload: true });
          }
          await window.mainPanel.switchTab(sessionId);
        } else {
          throw new Error('Renderer session switch helper is unavailable');
        }
        return {
          success: true,
          activeTabId: String(window.mainPanel?.activeTabId || ''),
          sidebarSessionId: String(window.sidebar?.currentSessionId || '')
        };
      })()`.replace('__SESSION_ID__', normalizedSessionId), true);
      return result && typeof result === 'object' ? result : { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('app:open-superagent-manager', async (event) => {
    const activeWindow = resolveActiveWindow(event, runtime);
    if (!activeWindow?.webContents?.executeJavaScript) {
      return { success: false, error: 'No active window to control' };
    }
    try {
      const result = await activeWindow.webContents.executeJavaScript(`(async () => {
        if (window.mainPanel?.openSuperagentManagerTab) {
          await window.mainPanel.openSuperagentManagerTab();
        } else if (window.mainPanelTabs?.openSuperagentManagerTab && window.mainPanel) {
          await window.mainPanelTabs.openSuperagentManagerTab(window.mainPanel);
        } else {
          throw new Error('Renderer superagent manager helper is unavailable');
        }
        return {
          success: true,
          activeTabId: String(window.mainPanel?.activeTabId || ''),
          sidebarSessionId: String(window.sidebar?.currentSessionId || '')
        };
      })()`, true);
      return result && typeof result === 'object' ? result : { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('app:refresh-window', async (event) => {
    const ownerWindow = resolveOwnerWindow(event);
    if (!ownerWindow?.webContents?.reloadIgnoringCache) {
      return { success: false, error: 'No active window to refresh' };
    }

    setTimeout(() => {
      try {
        ownerWindow.webContents.reloadIgnoringCache();
      } catch (error) {
        console.error('[IPC] app:refresh-window reload failed:', error);
      }
    }, 25);

    return { success: true };
  });

  ipcMain.handle('app:restart', async () => {
    const relaunchArgs = buildRelaunchArgs(process.argv.slice(1));

    setTimeout(() => {
      try {
        app.relaunch({ args: relaunchArgs });
        app.quit();
      } catch (error) {
        console.error('[IPC] app:restart relaunch failed:', error);
      }
    }, 25);

    return {
      success: true,
      relaunchArgs
    };
  });

  const listProfiles = async () => {
    const { profileRegistry, profileSwitcher } = getProfileServices(runtime);
    if (!profileRegistry && !profileSwitcher && !runtime.activeProfile) {
      return { success: false, error: 'Profile switching is unavailable in this runtime' };
    }
    return buildProfileState(runtime);
  };

  const createProfile = async (input = {}) => {
    const { profileRegistry } = getProfileServices(runtime);
    if (typeof profileRegistry?.ensureProfile !== 'function') {
      return { success: false, error: 'Profile registry is unavailable' };
    }

    const requestedProfileId = normalizeValue(typeof input === 'string' ? input : input?.userId);
    if (!requestedProfileId) {
      return { success: false, error: 'userId is required' };
    }
    if (requestedProfileId === 'owner' || requestedProfileId === 'localuser') {
      return { success: false, error: 'Named profiles only' };
    }

    const displayName = String(input?.displayName || '').trim();
    const profile = profileRegistry.ensureProfile(requestedProfileId, displayName ? { displayName } : {});
    return {
      ...buildProfileState(runtime),
      profile
    };
  };

  const switchProfile = async (rawProfileId: any) => {
    const { profileRegistry, profileSwitcher } = getProfileServices(runtime);
    if (typeof profileSwitcher?.selectProfile !== 'function') {
      return { success: false, error: 'Profile switching is unavailable' };
    }

    const requestedProfileId = normalizeValue(rawProfileId);
    if (!requestedProfileId) {
      return { success: false, error: 'userId is required' };
    }
    if (requestedProfileId === 'owner' || requestedProfileId === 'localuser') {
      return { success: false, error: 'Named profiles only' };
    }

    const existingProfile = typeof profileRegistry?.getProfile === 'function'
      ? profileRegistry.getProfile(requestedProfileId)
      : null;
    if (!existingProfile) {
      return { success: false, error: `Profile not found: ${requestedProfileId}` };
    }

    const profile = profileSwitcher.selectProfile(requestedProfileId);
    runtime.userAuth?.setActiveUser?.(profile.userId);
    return {
      ...buildProfileState(runtime),
      profile,
      requiresRestart: false,
      restartOptions: null
    };
  };

  const deleteProfile = async (rawProfileId: any) => {
    const { profileRegistry } = getProfileServices(runtime);
    if (typeof profileRegistry?.deleteProfile !== 'function') {
      return { success: false, error: 'Profile deletion is unavailable' };
    }

    const requestedProfileId = normalizeValue(typeof rawProfileId === 'string' ? rawProfileId : rawProfileId?.userId);
    if (!requestedProfileId) {
      return { success: false, error: 'userId is required' };
    }
    if (requestedProfileId === 'owner' || requestedProfileId === 'localuser') {
      return { success: false, error: 'Named profiles only' };
    }
    if (getActiveUser(runtime)?.userId === requestedProfileId) {
      return { success: false, error: 'The currently running profile cannot be deleted' };
    }

    const profile = profileRegistry.deleteProfile(requestedProfileId);
    if (!profile) {
      return { success: false, error:         `Profile not found: ${requestedProfileId}` };
    }

    return {
      ...buildProfileState(runtime),
      profile
    };
  };

  ipcMain.handle('profiles:list', async () => listProfiles());
  ipcMain.handle('profile:list', async () => listProfiles());

  ipcMain.handle('profiles:get-active', async () => ({ success: true, profile: getSelectedProfile(runtime), userId: getSelectedProfileId(runtime) }));
  ipcMain.handle('profile:get-active', async () => ({ success: true, profile: getSelectedProfile(runtime), userId: getSelectedProfileId(runtime) }));

  ipcMain.handle('profiles:create', async (event, input = {}) => createProfile(input));
  ipcMain.handle('profile:create', async (event, input = {}) => createProfile(input));

  ipcMain.handle('profiles:switch', async (event, rawProfileId) => switchProfile(rawProfileId));
  ipcMain.handle('profile:switch', async (event, rawProfileId) => switchProfile(rawProfileId));

  ipcMain.handle('profiles:delete', async (event, rawProfileId) => deleteProfile(rawProfileId));
  ipcMain.handle('profile:delete', async (event, rawProfileId) => deleteProfile(rawProfileId));

  ipcMain.handle('users:list', async () => {
    const { userRegistry, userAuth } = getUserServices(runtime);
    if (!userRegistry && !userAuth && !runtime.activeUser) {
      return { success: false, error: 'User registry is unavailable in this runtime' };
    }
    return accountService?.getState ? accountService.getState() : buildUserState(runtime);
  });

  ipcMain.handle('users:get-active', async () => {
    const { userRegistry, userAuth } = getUserServices(runtime);
    if (!userRegistry && !userAuth && !runtime.activeUser) {
      return { success: false, error: 'User registry is unavailable in this runtime' };
    }
    return accountService?.getState ? accountService.getState() : buildUserState(runtime);
  });

  ipcMain.handle('users:get-state', async () => {
    if (!accountService?.getState) {
      return { success: false, error: 'Desktop account service is unavailable' };
    }
    return accountService.getState();
  });

  ipcMain.handle('users:create', async (event, input = {}) => {
    const { userRegistry, userAuth } = getUserServices(runtime);
    const ensureUser = userAuth?.ensureUser || userRegistry?.ensureUser;
    if (typeof ensureUser !== 'function') {
      return { success: false, error: 'User registry is unavailable' };
    }

    const requestedUserId = normalizeValue(typeof input === 'string' ? input : input?.userId);
    if (!requestedUserId) {
      return { success: false, error: 'userId is required' };
    }

    const user = ensureUser(requestedUserId, {
      authProvider: normalizeValue(input?.authProvider) || undefined,
      displayName: normalizeValue(input?.displayName) || undefined,
      role: normalizeValue(input?.role) || undefined,
      username: normalizeValue(input?.username) || undefined
    });
    return {
      ...(accountService?.getState ? accountService.getState() : buildUserState(runtime)),
      user
    };
  });

  ipcMain.handle('users:register', async (event, input = {}) => {
    if (!accountService?.register) {
      return { success: false, error: 'Desktop account service is unavailable' };
    }
    try {
      return await accountService.register(input || {});
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('users:login', async (event, input = {}) => {
    if (!accountService?.login) {
      return { success: false, error: 'Desktop account service is unavailable' };
    }
    try {
      return accountService.login(input || {});
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('users:switch', async (event, input = {}) => {
    if (!accountService?.switchUser) {
      return { success: false, error: 'Desktop account service is unavailable' };
    }
    const requestedUserId = normalizeValue(typeof input === 'string' ? input : input?.userId);
    if (requestedUserId !== 'localuser') {
      return { success: false, error: 'Named accounts must sign in' };
    }
    try {
      return accountService.switchUser(input || {});
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ui:get-typefaces', async () => readTypefaceList(runtime.runtimePaths || {}));

  ipcMain.handle('shell:open-external', async (event, rawUrl) => {
    if (!shell?.openExternal) {
      return { success: false, error: 'Shell integration is unavailable' };
    }
    let target = null;
    try {
      target = new URL(String(rawUrl || '').trim());
    } catch (_) {
      return { success: false, error: 'Invalid external URL' };
    }
    if (!['http:', 'https:', 'mailto:'].includes(target.protocol)) {
      return { success: false, error: 'External URL protocol is not allowed' };
    }
    await shell.openExternal(target.toString());
    return { success: true };
  });

  ipcMain.handle('shell:resolve-path', async (event, rawPath, options = {}) => {
    return resolveLocalPath(event, rawPath, options);
  });

  ipcMain.handle('shell:open-path', async (event, rawPath, options = {}) => {
    if (!shell?.openPath) {
      return { success: false, error: 'Shell integration is unavailable' };
    }
    const resolved = await resolveLocalPath(event, rawPath, options);
    if (!resolved.success) return resolved;
    const targetPath = resolved.path;
    const result = await shell.openPath(targetPath);
    return result
      ? { success: false, error: result }
      : { success: true, path: targetPath };
  });

  ipcMain.handle('shell:show-item-in-folder', async (event, rawPath, options = {}) => {
    if (!shell?.showItemInFolder) {
      return { success: false, error: 'Shell integration is unavailable' };
    }
    const resolved = await resolveLocalPath(event, rawPath, options);
    if (!resolved.success) return resolved;
    const targetPath = resolved.path;
    shell.showItemInFolder(targetPath);
    return { success: true, path: targetPath };
  });
}

module.exports = { registerAppControlHandlers };





