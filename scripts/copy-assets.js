// Copies non-code runtime assets (JSON specs, companion web UI, scripts) from
// src/main into dist/src/main so the compiled runtime can find them at runtime.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'main');
const DST = path.join(ROOT, 'dist', 'src', 'main');
const CODE_EXTENSIONS = new Set(['.ts', '.js']);

function walk(dir, shouldCopy) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const srcPath = path.join(dir, entry.name);
    const dstPath = path.join(DST, path.relative(SRC, srcPath));
    if (entry.isDirectory()) {
      walk(srcPath, shouldCopy);
    } else if (shouldCopy(srcPath, entry)) {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

walk(SRC, (_srcPath, entry) => !CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));

// Shared utilities the backend requires from the renderer tree. These are
// plain JS (not compiled by tsc) and must be present next to the runtime.
const RENDERER_SHARED = [
  path.join('components', 'tts-text-utils.js')
];
for (const rel of RENDERER_SHARED) {
  const src = path.join(ROOT, 'src', 'renderer', rel);
  const dst = path.join(ROOT, 'dist', 'src', 'renderer', rel);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

console.log('[copy-assets] Synced runtime assets into dist/src/main');
