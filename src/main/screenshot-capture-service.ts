// @ts-nocheck
const fs = require('fs').promises;
const path = require('path');

function loadElectron() {
  try {
    return require('electron');
  } catch (_) {
    return {};
  }
}

function normalizeLimit(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16384) {
    throw new Error(`${name} must be an integer between 1 and 16384`);
  }
  return parsed;
}

function resizeToFit(image, maxWidth, maxHeight) {
  const original = image?.getSize?.() || { width: 0, height: 0 };
  if (!original.width || !original.height) return image;
  const widthLimit = normalizeLimit(maxWidth, 'maxWidth') || original.width;
  const heightLimit = normalizeLimit(maxHeight, 'maxHeight') || original.height;
  const ratio = Math.min(1, widthLimit / original.width, heightLimit / original.height);
  if (ratio >= 1) return image;
  return image.resize({
    width: Math.max(1, Math.floor(original.width * ratio)),
    height: Math.max(1, Math.floor(original.height * ratio)),
    quality: 'best'
  });
}

function windowMetadata(windowRef) {
  let bounds = null;
  try { bounds = windowRef.getBounds?.() || null; } catch (_) {}
  let title = '';
  try { title = String(windowRef.getTitle?.() || windowRef.webContents?.getTitle?.() || ''); } catch (_) {}
  return {
    id: String(windowRef.id || ''),
    name: title || 'LocalAgent',
    type: 'self',
    width: Number(bounds?.width || 0) || null,
    height: Number(bounds?.height || 0) || null,
    focused: Boolean(windowRef.isFocused?.())
  };
}

class ScreenshotCaptureService {
  constructor(options = {}) {
    this.windowManager = options.windowManager || null;
    this.electron = options.electron || null;
  }

  _electron() {
    return this.electron || loadElectron();
  }

  _ownedWindows() {
    const { BrowserWindow } = this._electron();
    const windows = BrowserWindow?.getAllWindows?.() || [];
    return windows.filter(windowRef => windowRef && !windowRef.isDestroyed?.());
  }

  _selfWindow(sourceId = '') {
    const { BrowserWindow } = this._electron();
    const requestedId = Number(sourceId || 0);
    if (requestedId > 0) {
      const requested = BrowserWindow?.fromId?.(requestedId);
      if (requested && !requested.isDestroyed?.()) return requested;
    }
    const managed = this.windowManager?.getMainWindow?.();
    if (managed && !managed.isDestroyed?.()) return managed;
    return this._ownedWindows().find(windowRef => windowRef.isFocused?.()) || this._ownedWindows()[0] || null;
  }

  _displayMetadata() {
    const { screen } = this._electron();
    return (screen?.getAllDisplays?.() || []).map(display => ({
      id: String(display.id),
      name: display.label || `Display ${display.id}`,
      type: 'screen',
      width: Math.round(Number(display.size?.width || 0) * Number(display.scaleFactor || 1)) || null,
      height: Math.round(Number(display.size?.height || 0) * Number(display.scaleFactor || 1)) || null,
      primary: screen?.getPrimaryDisplay?.()?.id === display.id
    }));
  }

  async listSources(target) {
    if (target === 'self') {
      return this._ownedWindows().map(windowMetadata);
    }
    const { desktopCapturer } = this._electron();
    if (!desktopCapturer?.getSources) throw new Error('Desktop capture is unavailable');
    const sourceType = target === 'screen' ? 'screen' : 'window';
    const sources = await desktopCapturer.getSources({
      types: [sourceType],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: target === 'application'
    });
    const displays = this._displayMetadata();
    return sources.map(source => {
      const display = displays.find(item => item.id === String(source.display_id || ''));
      return {
        id: String(source.id),
        displayId: source.display_id ? String(source.display_id) : null,
        name: String(source.name || (target === 'screen' ? 'Display' : 'Application')),
        type: target,
        width: display?.width || null,
        height: display?.height || null,
        primary: Boolean(display?.primary)
      };
    });
  }

  async _captureSelf(sourceId) {
    const windowRef = this._selfWindow(sourceId);
    if (!windowRef?.webContents?.capturePage) throw new Error('No LocalAgent window is available to capture');
    const image = await windowRef.webContents.capturePage();
    return { image, source: windowMetadata(windowRef) };
  }

  async _captureExternal(target, sourceId, displayId) {
    const { desktopCapturer, screen } = this._electron();
    if (!desktopCapturer?.getSources) throw new Error('Desktop capture is unavailable');
    const displays = this._displayMetadata();
    const largestWidth = Math.max(1, ...displays.map(item => item.width || 0));
    const largestHeight = Math.max(1, ...displays.map(item => item.height || 0));
    const sources = await desktopCapturer.getSources({
      types: [target === 'screen' ? 'screen' : 'window'],
      thumbnailSize: { width: largestWidth, height: largestHeight },
      fetchWindowIcons: target === 'application'
    });
    let source = sourceId ? sources.find(item => String(item.id) === String(sourceId)) : null;
    if (!source && target === 'screen' && displayId) {
      source = sources.find(item => String(item.display_id || '') === String(displayId));
    }
    if (!source && target === 'screen') {
      const primaryId = String(screen?.getPrimaryDisplay?.()?.id || '');
      source = sources.find(item => String(item.display_id || '') === primaryId) || sources[0];
    }
    if (!source) {
      throw new Error(target === 'application' ? 'Application sourceId was not found' : 'Screen source was not found');
    }
    return {
      image: source.thumbnail,
      source: {
        id: String(source.id),
        displayId: source.display_id ? String(source.display_id) : null,
        name: String(source.name || target),
        type: target
      }
    };
  }

  async capture({ target = 'self', sourceId = '', displayId = '', maxWidth, maxHeight } = {}) {
    normalizeLimit(maxWidth, 'maxWidth');
    normalizeLimit(maxHeight, 'maxHeight');
    const captured = target === 'self'
      ? await this._captureSelf(sourceId)
      : await this._captureExternal(target, sourceId, displayId);
    if (!captured.image || captured.image.isEmpty?.()) throw new Error('Screenshot capture produced an empty image');
    const image = resizeToFit(captured.image, maxWidth, maxHeight);
    const size = image.getSize?.() || { width: null, height: null };
    return { image, source: captured.source, width: size.width, height: size.height };
  }

  async writePng(image, outputPath) {
    const png = Buffer.from(image?.toPNG?.() || []);
    if (!png.length) throw new Error('Screenshot encoding produced an empty PNG');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, png);
    return { path: outputPath, size: png.length };
  }
}

module.exports = { ScreenshotCaptureService, resizeToFit };
