// @ts-nocheck
const os = require('os');

function unique(values = []) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function getLanIpv4Entries() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : String(entry.family || '');
      if (family !== 'IPv4' || entry.internal) continue;
      if (!entry.address || entry.address.startsWith('169.254.')) continue;
      addresses.push({ name, address: entry.address });
    }
  }

  return addresses;
}

function isPrivateIpv4(address) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(String(address || ''));
}

function scoreInterface(entry) {
  // Companion links should prefer real LAN/Wi-Fi adapters over virtual or VPN
  // interfaces because users copy these URLs to phones on the same network.
  const name = String(entry.name || '').toLowerCase();
  let score = isPrivateIpv4(entry.address) ? 20 : 0;
  if (/wi-?fi|wlan|wireless/.test(name)) score += 30;
  if (/ethernet|lan/.test(name)) score += 20;
  if (/virtual|vmware|virtualbox|vbox|hyper-v|vethernet|wsl|tap|tun|vpn|tailscale|zerotier|docker/.test(name)) score -= 40;
  return score;
}

function getLanIpv4Addresses() {
  return unique(getLanIpv4Entries()
    .sort((a, b) => scoreInterface(b) - scoreInterface(a))
    .map(entry => entry.address));
}

function normalizeHost(host) {
  return String(host || '0.0.0.0').trim() || '0.0.0.0';
}

function isWildcardHost(host) {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function resolveEasyConnectHost(host) {
  // A localhost bind is fine for desktop, but useless for phone pairing.
  // Normalize it to wildcard so the companion URL can use a LAN address.
  return isLoopbackHost(host) ? '0.0.0.0' : normalizeHost(host);
}

function getReachableHosts(bindHost) {
  const normalized = normalizeHost(bindHost);

  if (isWildcardHost(normalized)) {
    const lanHosts = getLanIpv4Addresses();
    return unique([...lanHosts, '127.0.0.1']);
  }

  if (isLoopbackHost(normalized)) {
    return ['127.0.0.1'];
  }

  return [normalized];
}

function buildCompanionUrl(host, port, options = {}) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = Number(port) || 8790;
  const scheme = String(options.scheme || 'http').trim() || 'http';
  const pathname = String(options.pathname || '/companion/web').trim() || '/companion/web';
  const params = new URLSearchParams();

  if (options.pairingCode) params.set('code', String(options.pairingCode));
  if (options.deviceName) params.set('device', String(options.deviceName));
  if (options.query && typeof options.query === 'object') {
    for (const [key, value] of Object.entries(options.query)) {
      if (value == null || value === '') continue;
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  return `${scheme}://${normalizedHost}:${normalizedPort}${pathname}${query ? `?${query}` : ''}`;
}

function buildBrowserUrl(host, port, options = {}) {
  return buildCompanionUrl(host, port, {
    ...options,
    pathname: options.pathname || '/companion/web'
  });
}

function buildNativeCompanionUrl(host, port, options = {}) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = Number(port) || 8790;
  const params = new URLSearchParams({
    host: normalizedHost,
    port: String(normalizedPort),
    tls: options.useTls === true ? '1' : '0'
  });

  if (options.pairingCode) params.set('code', String(options.pairingCode));
  return `localagent-companion://companion?${params.toString()}`;
}

function describeCompanionReachability(host, port, options = {}) {
  const bindHost = normalizeHost(host);
  const reachableHosts = getReachableHosts(bindHost);
  const browserUrls = reachableHosts.map((entryHost) => buildCompanionUrl(entryHost, port, options));
  const preferredHost = reachableHosts.find((entryHost) => entryHost !== '127.0.0.1')
    || reachableHosts[0]
    || bindHost;
  const preferredBrowserUrl = preferredHost ? buildCompanionUrl(preferredHost, port, options) : '';

  let accessMode = 'external';
  let warning = '';

  if (isLoopbackHost(bindHost)) {
    accessMode = 'local-only';
    warning = 'Bound to localhost only. Phones and other devices cannot connect.';
  } else if (isWildcardHost(bindHost) && reachableHosts.length <= 1) {
    accessMode = 'unknown-lan';
    warning = 'No Wi-Fi/LAN IPv4 address was detected. Connect this PC and phone to the same non-guest network.';
  } else if (isWildcardHost(bindHost)) {
    accessMode = 'lan';
  }

  return {
    bindHost,
    host: bindHost,
    port: Number(port) || 8790,
    reachableHosts,
    preferredHost,
    browserUrls,
    preferredBrowserUrl,
    accessMode,
    warning
  };
}

module.exports = {
  buildNativeCompanionUrl,
  buildBrowserUrl,
  buildCompanionUrl,
  describeCompanionReachability,
  getLanIpv4Addresses,
  getLanIpv4Entries,
  getReachableHosts,
  isLoopbackHost,
  isWildcardHost,
  normalizeHost,
  resolveEasyConnectHost,
  scoreInterface
};
