const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = '15.1.0';
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
let runtimeContext = null;
let installPromise = null;

const TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc.zip',
  'win32-arm64': 'aarch64-pc-windows-msvc.zip',
  'darwin-x64': 'x86_64-apple-darwin.tar.gz',
  'darwin-arm64': 'aarch64-apple-darwin.tar.gz',
  'linux-x64': 'x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'aarch64-unknown-linux-gnu.tar.gz'
};

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || String(value).toLowerCase() === 'true';
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function managedBinaryPath(context) {
  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg';
  return path.join(context.dataDir, VERSION, `${process.platform}-${process.arch}`, executable);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: options.env || process.env
    });
    const unregister = options.context?.registerManagedProcess?.(child, {
      name: options.name || 'ripgrep'
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let exceeded = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs || 15000);

    child.stdout?.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > (options.maxOutputBytes || MAX_OUTPUT_BYTES)) {
        exceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', error => {
      clearTimeout(timeout);
      unregister?.();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      unregister?.();
      resolve({ code, signal, stdout, stderr, exceeded });
    });
  });
}

async function probe(command, context) {
  try {
    const result = await runProcess(command, ['--version'], {
      context,
      name: 'ripgrep-version',
      timeoutMs: 2500,
      maxOutputBytes: 4096
    });
    if (result.code !== 0) return null;
    const firstLine = result.stdout.trim().split(/\r?\n/)[0];
    if (!/^ripgrep\s+/i.test(firstLine)) return null;
    return { command, version: firstLine };
  } catch (_) {
    return null;
  }
}

async function resolveBinary(context) {
  const managed = managedBinaryPath(context);
  const preferSystem = asBool(context.getConfig('preferSystem'), false);
  const candidates = preferSystem ? ['rg', managed] : [managed, 'rg'];
  for (const candidate of candidates) {
    if (candidate !== 'rg' && !fs.existsSync(candidate)) continue;
    const found = await probe(candidate, context);
    if (found) {
      return {
        ...found,
        source: candidate === managed ? 'managed' : 'system',
        path: candidate
      };
    }
  }
  return null;
}

function downloadBuffer(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many download redirects'));
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': `LocalAgent-Ripgrep/${VERSION}` }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(downloadBuffer(new URL(response.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) {
          request.destroy(new Error('Ripgrep download exceeded 20 MB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(new Error('Ripgrep download timed out')));
    request.on('error', reject);
  });
}

async function findExecutable(root) {
  const wanted = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.name === wanted) return fullPath;
    }
  }
  return null;
}

async function installBinary(context, force = false) {
  if (installPromise) return installPromise;
  installPromise = (async () => {
    const existing = await resolveBinary(context);
    if (existing && !force) return { installed: false, ...existing };

    const target = TARGETS[`${process.platform}-${process.arch}`];
    if (!target) throw new Error(`No managed Ripgrep build for ${process.platform}-${process.arch}`);
    const asset = `ripgrep-${VERSION}-${target}`;
    const baseUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${asset}`;
    const [archive, checksumFile] = await Promise.all([
      downloadBuffer(baseUrl),
      downloadBuffer(`${baseUrl}.sha256`)
    ]);
    const expected = checksumFile.toString('utf8').match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
    const actual = crypto.createHash('sha256').update(archive).digest('hex');
    if (!expected || actual !== expected) throw new Error('Ripgrep archive checksum verification failed');

    const installRoot = path.dirname(managedBinaryPath(context));
    const tempRoot = path.join(context.dataDir, `.install-${Date.now()}`);
    const archivePath = path.join(tempRoot, asset);
    await fsp.mkdir(tempRoot, { recursive: true });
    try {
      await fsp.writeFile(archivePath, archive);
      const extracted = path.join(tempRoot, 'extracted');
      await fsp.mkdir(extracted, { recursive: true });
      const unpack = await runProcess('tar', ['-xf', archivePath, '-C', extracted], {
        context,
        name: 'ripgrep-extract',
        timeoutMs: 30000,
        maxOutputBytes: 1024 * 1024
      });
      if (unpack.code !== 0) throw new Error(unpack.stderr || 'Could not extract Ripgrep archive');
      const extractedBinary = await findExecutable(extracted);
      if (!extractedBinary) throw new Error('Downloaded archive did not contain Ripgrep');
      await fsp.mkdir(installRoot, { recursive: true });
      const destination = managedBinaryPath(context);
      await fsp.copyFile(extractedBinary, destination);
      if (process.platform !== 'win32') await fsp.chmod(destination, 0o755);
      const verified = await probe(destination, context);
      if (!verified) throw new Error('Installed Ripgrep binary did not start correctly');
      return { installed: true, source: 'managed', path: destination, version: verified.version };
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  })();
  try {
    return await installPromise;
  } finally {
    installPromise = null;
  }
}

async function requireBinary(context) {
  const found = await resolveBinary(context);
  if (found) return found;
  if (!asBool(context.getConfig('autoInstall'), true)) {
    throw new Error('Ripgrep is not installed. Open Plugin Studio → Ripgrep and choose Install.');
  }
  await installBinary(context);
  const installed = await resolveBinary(context);
  if (!installed) throw new Error('Ripgrep installation completed but the binary is unavailable');
  return installed;
}

function parseMatches(stdout, maxResults) {
  const matches = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }
    if (event.type !== 'match' || !event.data) continue;
    const text = event.data.lines?.text || '';
    const submatch = event.data.submatches?.[0] || null;
    matches.push({
      path: event.data.path?.text || '',
      line: event.data.line_number || null,
      column: submatch ? submatch.start + 1 : null,
      text: text.replace(/[\r\n]+$/, '').slice(0, 1000)
    });
    if (matches.length >= maxResults) break;
  }
  return matches;
}

async function search(params, context) {
  const query = String(params.query || '').trim();
  if (!query) throw new Error('ripgrep requires a non-empty query');
  const searchPath = await context.paths.resolve(params.path || '');
  const binary = await requireBinary(context);
  const maxResults = boundedNumber(params.max_results, 100, 1, 500);
  const contextLines = boundedNumber(params.context_lines, 0, 0, 20);
  const args = ['--json', '--no-config', '--color', 'never', '--max-columns', '1000'];
  if (params.regex !== true) args.push('--fixed-strings');
  if (params.case_sensitive !== true) args.push('--ignore-case');
  if (params.hidden === true) args.push('--hidden');
  if (contextLines) args.push('--context', String(contextLines));
  const globs = Array.isArray(params.glob) ? params.glob : (params.glob ? [params.glob] : []);
  for (const glob of globs.slice(0, 20)) args.push('--glob', String(glob));
  args.push(query, searchPath);

  const result = await runProcess(binary.command, args, {
    context,
    name: 'ripgrep-search',
    cwd: searchPath,
    timeoutMs: boundedNumber(context.getConfig('timeoutMs'), 15000, 1000, 120000)
  });
  if (result.code !== 0 && result.code !== 1 && !result.exceeded) {
    throw new Error(result.stderr.trim() || `Ripgrep exited with code ${result.code}`);
  }
  const matches = parseMatches(result.stdout, maxResults);
  for (const match of matches) {
    match.path = await context.paths.portable(path.resolve(match.path));
  }
  return {
    query,
    path: await context.paths.portable(searchPath),
    engine: binary.source,
    version: binary.version,
    matchCount: matches.length,
    truncated: result.exceeded || matches.length >= maxResults,
    matches
  };
}

async function status(context) {
  const binary = await resolveBinary(context);
  return {
    available: Boolean(binary),
    source: binary?.source || 'not-installed',
    version: binary?.version || null,
    path: binary?.path || managedBinaryPath(context),
    target: `${process.platform}-${process.arch}`,
    managedVersion: VERSION,
    autoInstall: asBool(context.getConfig('autoInstall'), true)
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

async function renderSetupUI(context) {
  const current = await status(context);
  const autoInstall = asBool(context.getConfig('autoInstall'), true);
  const preferSystem = asBool(context.getConfig('preferSystem'), false);
  const readyClass = current.available ? 'is-ready' : 'is-missing';
  const stateLabel = current.available ? 'Ready' : 'Not installed';
  return {
    html: `<section class="rg-card ${readyClass}">
      <div class="rg-hero"><div class="rg-mark">rg</div><div><h3>Fast project search</h3><p>Local, private, and designed for large codebases.</p></div><span class="rg-state">${stateLabel}</span></div>
      <div class="rg-details"><div><span>Source</span><strong>${escapeHtml(current.source)}</strong></div><div><span>Version</span><strong>${escapeHtml(current.version || VERSION)}</strong></div><div><span>Platform</span><strong>${escapeHtml(current.target)}</strong></div></div>
      <div class="rg-settings"><div><span>Install when needed</span><div role="group"><button type="button" class="rg-choice ${autoInstall ? 'is-active' : ''}" data-config-key="autoInstall" data-config-value="true">On</button><button type="button" class="rg-choice ${!autoInstall ? 'is-active' : ''}" data-config-key="autoInstall" data-config-value="false">Off</button></div></div><div><span>Prefer system rg</span><div role="group"><button type="button" class="rg-choice ${preferSystem ? 'is-active' : ''}" data-config-key="preferSystem" data-config-value="true">On</button><button type="button" class="rg-choice ${!preferSystem ? 'is-active' : ''}" data-config-key="preferSystem" data-config-value="false">Off</button></div></div></div>
      <div class="rg-note">The native binary is about 4 MB. It runs only during a search and does not start a server.</div>
      <div class="rg-actions"><button type="button" class="compact-btn" data-plugin-action="install">${current.available ? 'Verify / reinstall' : 'Install Ripgrep'}</button><button type="button" class="compact-btn" data-plugin-action="status">Refresh status</button></div>
    </section>`,
    css: `.rg-card{display:grid;gap:16px;padding:18px;border:1px solid var(--border-color,#303744);border-radius:14px;background:linear-gradient(145deg,rgba(44,123,229,.10),rgba(20,24,32,.25))}.rg-hero{display:grid;grid-template-columns:auto 1fr auto;gap:13px;align-items:center}.rg-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:11px;background:#2c7be5;color:white;font:700 17px ui-monospace,monospace;box-shadow:0 8px 22px rgba(44,123,229,.25)}.rg-hero h3{margin:0 0 3px;font-size:15px}.rg-hero p{margin:0;opacity:.7;font-size:12px}.rg-state{padding:5px 9px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(245,158,11,.14);color:#f59e0b}.is-ready .rg-state{background:rgba(34,197,94,.14);color:#22c55e}.rg-details{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.rg-details div{padding:10px;border-radius:9px;background:rgba(127,127,127,.07)}.rg-details span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.55}.rg-details strong{display:block;margin-top:4px;font-size:12px;overflow:hidden;text-overflow:ellipsis}.rg-settings{display:grid;gap:8px}.rg-settings>div{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px}.rg-settings [role=group]{display:flex;padding:2px;border-radius:8px;background:rgba(127,127,127,.1)}.rg-choice{border:0;border-radius:6px;padding:5px 9px;background:transparent;color:inherit;font-size:11px;cursor:pointer;opacity:.62}.rg-choice.is-active{background:rgba(44,123,229,.22);color:#74aaf2;opacity:1}.rg-note{font-size:12px;line-height:1.5;opacity:.72}.rg-actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:620px){.rg-hero{grid-template-columns:auto 1fr}.rg-state{grid-column:1/-1;width:max-content}.rg-details{grid-template-columns:1fr}}`
  };
}

async function runAction(action, params, context) {
  if (action === 'status' || action === 'discover') return status(context);
  if (action === 'install') return installBinary(context, true);
  throw new Error(`Unknown Ripgrep action: ${action}`);
}

async function onEnable(context) {
  runtimeContext = context;
  context.registerHandler('search', {
    toolName: 'ripgrep',
    privateSafe: true,
    description: 'Search files recursively with Ripgrep. Prefer this for finding code, symbols, text, references, and filenames in the current project before reading or editing files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to search for by default, or a regex when regex=true.' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the current execution root.' },
        glob: { description: 'Optional glob string or list, such as "*.ts" or ["*.js", "!dist/**"].' },
        regex: { type: 'boolean', description: 'Interpret query as a regular expression. Default false.' },
        case_sensitive: { type: 'boolean', description: 'Use case-sensitive matching. Default false.' },
        hidden: { type: 'boolean', description: 'Include hidden files while still respecting ignore rules.' },
        context_lines: { type: 'number', description: 'Context lines around matches, from 0 to 20.' },
        max_results: { type: 'number', description: 'Maximum structured matches, from 1 to 500. Default 100.' }
      },
      required: ['query']
    }
  }, (params) => search(params, context));
  context.log('Ripgrep tool registered');
}

async function onDisable() {
  runtimeContext = null;
}

module.exports = {
  onEnable,
  onDisable,
  renderSetupUI,
  runAction,
  _test: { parseMatches, managedBinaryPath, resolveBinary, runProcess, status }
};
