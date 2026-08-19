// @ts-nocheck
const fs = require('fs');
const path = require('path');

const COMPANION_BOOTSTRAP_ROOT = path.join(__dirname, 'companion-bootstrap');
const COMPANION_WEB_ROOT = path.join(__dirname, 'companion-web');
const RENDERER_SKINS_ROOT = path.join(__dirname, '..', '..', 'renderer', 'skins');
const INDEX_FILE = 'index.html';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp'
};

function normalizeWebRequestPath(urlPath = '/companion/web/') {
  const raw = String(urlPath || '/companion/web/').split('?', 1)[0];
  if (raw === '/' || raw === '/companion/web' || raw === '/companion/web/') {
    return INDEX_FILE;
  }
  if (!raw.startsWith('/companion/web/')) {
    return null;
  }
  const relative = decodeURIComponent(raw.slice('/companion/web/'.length)).replace(/\\/g, '/');
  return relative || INDEX_FILE;
}

function resolveCompanionWebFile(urlPath = '/companion/web/') {
  const relative = normalizeWebRequestPath(urlPath);
  if (!relative) return null;

  const requested = path.resolve(COMPANION_WEB_ROOT, relative);
  const root = path.resolve(COMPANION_WEB_ROOT);
  if (requested !== root && !requested.startsWith(root + path.sep)) {
    return null;
  }

  const targetPath = fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : (relative === INDEX_FILE ? requested : null);

  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }

  const ext = path.extname(targetPath).toLowerCase();
  return {
    absolutePath: targetPath,
    contentType: CONTENT_TYPES[ext] || 'application/octet-stream'
  };
}

function resolveCompanionBootstrapFile(urlPath = '/companion/bootstrap') {
  const raw = String(urlPath || '').split('?', 1)[0];
  if (raw !== '/companion/bootstrap' && raw !== '/companion/bootstrap/') return null;
  const targetPath = path.resolve(COMPANION_BOOTSTRAP_ROOT, INDEX_FILE);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) return null;
  return {
    absolutePath: targetPath,
    contentType: CONTENT_TYPES['.html']
  };
}

function resolveCompanionSkinFile(urlPath = '/companion/skins/') {
  const raw = String(urlPath || '').split('?', 1)[0];
  if (!raw.startsWith('/companion/skins/')) return null;

  const relative = decodeURIComponent(raw.slice('/companion/skins/'.length)).replace(/\\/g, '/');
  if (!relative || relative.includes('\0')) return null;

  const requested = path.resolve(RENDERER_SKINS_ROOT, relative);
  const root = path.resolve(RENDERER_SKINS_ROOT);
  if (requested !== root && !requested.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) return null;

  const ext = path.extname(requested).toLowerCase();
  return {
    absolutePath: requested,
    contentType: CONTENT_TYPES[ext] || 'application/octet-stream'
  };
}

module.exports = {
  COMPANION_BOOTSTRAP_ROOT,
  COMPANION_WEB_ROOT,
  RENDERER_SKINS_ROOT,
  resolveCompanionBootstrapFile,
  resolveCompanionSkinFile,
  resolveCompanionWebFile
};
