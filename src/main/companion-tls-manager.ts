// @ts-nocheck
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getReachableHosts, normalizeHost } = require('./companion-network-utils');

const TLS_ENABLED_KEY = 'companion.tls.enabled';
const TLS_SECURE_PORT_KEY = 'companion.tls.securePort';

function readJsonFile(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function isIpv4Address(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function isDnsLikeHost(value) {
  return /^[a-z0-9.-]+$/i.test(String(value || '').trim());
}

function buildDefaultSecurePort(httpPort) {
  const normalized = Number(httpPort) || 8790;
  if (normalized >= 1 && normalized < 65535) return normalized + 1;
  return 8791;
}

function uniqueHosts(hosts = []) {
  const seen = new Set();
  const out = [];
  for (const entry of hosts) {
    const normalized = String(entry || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || 120_000);
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      const error = new Error(`TLS setup timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      error.stdout = stdout.join('');
      error.stderr = stderr.join('');
      reject(error);
    }, timeoutMs);

    child.stdout.on('data', chunk => stdout.push(String(chunk)));
    child.stderr.on('data', chunk => stderr.push(String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const result = {
        code,
        stdout: stdout.join(''),
        stderr: stderr.join('')
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const error = new Error(result.stderr.trim() || result.stdout.trim() || `Process exited with code ${code}`);
      error.code = code;
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      reject(error);
    });
  });
}

class CompanionTlsManager {
  constructor(db, runtimePaths = {}, options = {}) {
    this.db = db;
    this.runtimePaths = runtimePaths;
    // TLS artifacts live outside source control in userData/agentin. The
    // companion server only reads PFX options from here; generation stays here.
    this.baseDir = options.baseDir
      || path.join(runtimePaths.userDataPath || runtimePaths.agentinRoot || process.cwd(), 'companion-tls');
    this.metadataPath = path.join(this.baseDir, 'metadata.json');
    this.caCertPath = path.join(this.baseDir, 'localagent-companion-ca.cer');
    this.serverPfxPath = path.join(this.baseDir, 'localagent-companion-server.pfx');
    this.scriptPath = options.scriptPath || path.join(__dirname, 'scripts', 'generate-companion-tls.ps1');
    this.lastError = '';
  }

  supportsLocalTls() {
    return process.platform === 'win32' && fs.existsSync(this.scriptPath);
  }

  ensureBaseDir() {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  readMetadata() {
    return readJsonFile(this.metadataPath, {});
  }

  writeMetadata(payload) {
    writeJsonFile(this.metadataPath, payload || {});
  }

  async isEnabled() {
    return await this.db.getSetting(TLS_ENABLED_KEY) === 'true';
  }

  async setEnabled(enabled) {
    await this.db.saveSetting(TLS_ENABLED_KEY, enabled ? 'true' : 'false');
    return enabled === true;
  }

  async getSecurePort(httpPort) {
    const fallback = buildDefaultSecurePort(httpPort);
    const saved = Number(await this.db.getSetting(TLS_SECURE_PORT_KEY));
    if (Number.isInteger(saved) && saved >= 1 && saved <= 65535 && saved !== Number(httpPort)) {
      return saved;
    }
    await this.db.saveSetting(TLS_SECURE_PORT_KEY, String(fallback));
    return fallback;
  }

  buildCertificateHosts(bindHost) {
    const host = normalizeHost(bindHost);
    const reachableHosts = getReachableHosts(host);
    return uniqueHosts([
      'localhost',
      '127.0.0.1',
      os.hostname(),
      ...reachableHosts
    ]).filter(entry => isIpv4Address(entry) || isDnsLikeHost(entry));
  }

  isReady() {
    const meta = this.readMetadata();
    return Boolean(
      meta?.passphrase
      && fs.existsSync(this.caCertPath)
      && fs.existsSync(this.serverPfxPath)
    );
  }

  getHttpsOptions() {
    const meta = this.readMetadata();
    if (!meta?.passphrase || !fs.existsSync(this.serverPfxPath)) return null;
    return {
      pfx: fs.readFileSync(this.serverPfxPath),
      passphrase: String(meta.passphrase)
    };
  }

  async getStatus({ bindHost = '0.0.0.0', httpPort = 8790 } = {}) {
    // Status is intentionally rich because the desktop settings UI and the
    // bootstrap page both need to explain what is missing to the user.
    const enabled = await this.isEnabled();
    const supported = this.supportsLocalTls();
    const securePort = await this.getSecurePort(httpPort);
    const ready = this.isReady();
    const metadata = this.readMetadata();
    const certificateHosts = this.buildCertificateHosts(bindHost);
    const existingHosts = Array.isArray(metadata.hosts) ? metadata.hosts : [];
    const missingHosts = certificateHosts.filter(entry => !existingHosts.includes(entry));

    let warning = '';
    if (enabled && !supported) {
      warning = 'Android browser HTTPS setup is available only on Windows in this build.';
    } else if (enabled && !ready) {
      warning = 'Android browser HTTPS is enabled, but certificates are not set up yet.';
    } else if (enabled && missingHosts.length > 0) {
      warning = 'Android browser HTTPS should be refreshed for the current network address.';
    } else if (this.lastError) {
      warning = this.lastError;
    }

    return {
      enabled,
      supported,
      ready,
      securePort,
      setupRequired: !ready || missingHosts.length > 0,
      certificateHosts,
      missingHosts,
      caCertPath: this.caCertPath,
      caFingerprint: String(metadata.caFingerprint || '').trim(),
      serverFingerprint: String(metadata.serverFingerprint || '').trim(),
      generatedAt: String(metadata.generatedAt || '').trim(),
      warning,
      error: this.lastError
    };
  }

  async ensureSetup(bindHost, httpPort, options = {}) {
    // Windows certificate generation is delegated to PowerShell so Node does
    // not need to grow certificate-authority logic.
    if (!this.supportsLocalTls()) {
      throw new Error('Android browser HTTPS setup is only supported on Windows in this build.');
    }

    const { force = false } = options;
    const certificateHosts = this.buildCertificateHosts(bindHost);
    const metadata = this.readMetadata();
    const existingHosts = Array.isArray(metadata.hosts) ? metadata.hosts : [];
    const needsRefresh = force
      || !this.isReady()
      || certificateHosts.some(entry => !existingHosts.includes(entry));

    if (!needsRefresh) {
      this.lastError = '';
      return this.getStatus({ bindHost, httpPort });
    }

    const passphrase = force || !metadata.passphrase
      ? crypto.randomBytes(24).toString('hex')
      : String(metadata.passphrase);

    await this._runWindowsSetup(certificateHosts, passphrase);
    this.lastError = '';
    return this.getStatus({ bindHost, httpPort });
  }

  async _runWindowsSetup(hosts, passphrase) {
    this.ensureBaseDir();
    const commands = [
      {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath,
          '-OutputDir',
          this.baseDir,
          '-PfxPassword',
          passphrase,
          '-HostNamesJson',
          JSON.stringify(hosts)
        ]
      },
      {
        command: 'pwsh.exe',
        args: [
          '-NoProfile',
          '-File',
          this.scriptPath,
          '-OutputDir',
          this.baseDir,
          '-PfxPassword',
          passphrase,
          '-HostNamesJson',
          JSON.stringify(hosts)
        ]
      }
    ];

    let lastFailure = null;
    for (const entry of commands) {
      try {
        const result = await runProcess(entry.command, entry.args);
        const payload = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
        this.writeMetadata({
          passphrase,
          hosts,
          caThumbprint: payload.caThumbprint || '',
          serverThumbprint: payload.leafThumbprint || '',
          caFingerprint: payload.caFingerprint || '',
          serverFingerprint: payload.leafFingerprint || '',
          generatedAt: new Date().toISOString()
        });
        return payload;
      } catch (error) {
        lastFailure = error;
      }
    }

    this.lastError = lastFailure?.message || 'HTTPS setup failed';
    throw lastFailure || new Error(this.lastError);
  }
}

module.exports = {
  CompanionTlsManager,
  buildDefaultSecurePort
};
