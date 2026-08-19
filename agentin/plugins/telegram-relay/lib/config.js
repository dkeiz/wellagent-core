'use strict';

const BOT_CONNECTOR_SYNC_KEYS = Object.freeze([
  'botToken',
  'telegramReadingEnabled',
  'duplicateTelegramChat',
  'ownerChatId'
]);

const MTProtoConfigKeys = Object.freeze([
  'mtprotoEnabled',
  'mtprotoMode',
  'apiId',
  'apiHash',
  'phoneNumber',
  'sessionString',
  'defaultPeer',
  'proxyType',
  'proxyHost',
  'proxyPort',
  'proxyUsername',
  'proxyPassword',
  'proxySecret',
  'proxyTimeoutSec',
  'mtprotoPhoneCodeHash',
  'mtprotoPendingPhoneNumber',
  'mtprotoLastAuthUser',
  'mtprotoLastAuthAt'
]);

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function trimToEmpty(value) {
  return String(value || '').trim();
}

function normalizeMtprotoMode(value) {
  const mode = trimToEmpty(value).toLowerCase();
  return mode === 'bot' ? 'bot' : 'user';
}

function normalizeProxyType(value) {
  const type = trimToEmpty(value).toLowerCase();
  if (type === 'mtproxy') return 'mtproxy';
  if (type === 'socks5') return 'socks5';
  return 'none';
}

function getConfigSnapshot(context) {
  return {
    botToken: trimToEmpty(context.getConfig('botToken')),
    telegramReadingEnabled: parseBool(context.getConfig('telegramReadingEnabled'), false),
    duplicateTelegramChat: parseBool(context.getConfig('duplicateTelegramChat'), true),
    ownerChatId: trimToEmpty(context.getConfig('ownerChatId')),
    mtprotoEnabled: parseBool(context.getConfig('mtprotoEnabled'), false),
    mtprotoMode: normalizeMtprotoMode(context.getConfig('mtprotoMode')),
    apiId: trimToEmpty(context.getConfig('apiId')),
    apiHash: trimToEmpty(context.getConfig('apiHash')),
    phoneNumber: trimToEmpty(context.getConfig('phoneNumber')),
    sessionString: trimToEmpty(context.getConfig('sessionString')),
    defaultPeer: trimToEmpty(context.getConfig('defaultPeer')),
    proxyType: normalizeProxyType(context.getConfig('proxyType')),
    proxyHost: trimToEmpty(context.getConfig('proxyHost')),
    proxyPort: trimToEmpty(context.getConfig('proxyPort')),
    proxyUsername: trimToEmpty(context.getConfig('proxyUsername')),
    proxyPassword: trimToEmpty(context.getConfig('proxyPassword')),
    proxySecret: trimToEmpty(context.getConfig('proxySecret')),
    proxyTimeoutSec: parseNumber(context.getConfig('proxyTimeoutSec'), 5),
    mtprotoPhoneCodeHash: trimToEmpty(context.getConfig('mtprotoPhoneCodeHash')),
    mtprotoPendingPhoneNumber: trimToEmpty(context.getConfig('mtprotoPendingPhoneNumber')),
    mtprotoLastAuthUser: trimToEmpty(context.getConfig('mtprotoLastAuthUser')),
    mtprotoLastAuthAt: trimToEmpty(context.getConfig('mtprotoLastAuthAt'))
  };
}

async function ensureDefaults(context) {
  const defaults = {
    botToken: '',
    telegramReadingEnabled: 'false',
    duplicateTelegramChat: 'true',
    ownerChatId: '',
    mtprotoEnabled: 'false',
    mtprotoMode: 'user',
    apiId: '',
    apiHash: '',
    phoneNumber: '',
    sessionString: '',
    defaultPeer: '',
    proxyType: 'none',
    proxyHost: '',
    proxyPort: '1080',
    proxyUsername: '',
    proxyPassword: '',
    proxySecret: '',
    proxyTimeoutSec: '5',
    mtprotoPhoneCodeHash: '',
    mtprotoPendingPhoneNumber: '',
    mtprotoLastAuthUser: '',
    mtprotoLastAuthAt: ''
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (context.getConfig(key) == null) {
      await context.setConfig(key, value);
    }
  }
}

function buildProxyConfig(config = {}) {
  const proxyType = normalizeProxyType(config.proxyType);
  if (proxyType === 'none') return null;

  const ip = trimToEmpty(config.proxyHost);
  const port = parseNumber(config.proxyPort, 0);
  const timeout = parseNumber(config.proxyTimeoutSec, 5);
  if (!ip || !port) {
    throw new Error('Proxy host and port are required');
  }

  if (proxyType === 'socks5') {
    const proxy = {
      ip,
      port,
      socksType: 5,
      timeout
    };
    if (trimToEmpty(config.proxyUsername)) proxy.username = trimToEmpty(config.proxyUsername);
    if (trimToEmpty(config.proxyPassword)) proxy.password = trimToEmpty(config.proxyPassword);
    return proxy;
  }

  const secret = trimToEmpty(config.proxySecret);
  if (!secret) {
    throw new Error('MTProto proxy secret is required');
  }

  return {
    ip,
    port,
    secret,
    timeout,
    MTProxy: true
  };
}

function buildProxyLink(config = {}) {
  const proxyType = normalizeProxyType(config.proxyType);
  const host = trimToEmpty(config.proxyHost);
  const port = trimToEmpty(config.proxyPort);
  if (proxyType === 'none' || !host || !port) {
    return '';
  }

  const url = new URL(proxyType === 'mtproxy' ? 'tg://proxy' : 'tg://socks');
  url.searchParams.set('server', host);
  url.searchParams.set('port', port);

  if (proxyType === 'mtproxy') {
    const secret = trimToEmpty(config.proxySecret);
    if (!secret) {
      throw new Error('MTProto proxy secret is required');
    }
    url.searchParams.set('secret', secret);
    return url.toString();
  }

  if (trimToEmpty(config.proxyUsername)) {
    url.searchParams.set('user', trimToEmpty(config.proxyUsername));
  }
  if (trimToEmpty(config.proxyPassword)) {
    url.searchParams.set('pass', trimToEmpty(config.proxyPassword));
  }
  return url.toString();
}

function parseProxyLink(rawLink) {
  const raw = trimToEmpty(rawLink);
  if (!raw) {
    throw new Error('Proxy address is required');
  }

  if (!raw.includes('://') && !raw.startsWith('https://')) {
    const parts = raw.split(':').map((item) => item.trim()).filter(Boolean);
    if (parts.length === 2) {
      return {
        proxyType: 'socks5',
        proxyHost: parts[0],
        proxyPort: parts[1],
        proxyUsername: '',
        proxyPassword: '',
        proxySecret: ''
      };
    }
    if (parts.length >= 3) {
      return {
        proxyType: 'mtproxy',
        proxyHost: parts[0],
        proxyPort: parts[1],
        proxyUsername: '',
        proxyPassword: '',
        proxySecret: parts.slice(2).join(':')
      };
    }
    throw new Error('Proxy address must be tg://..., https://t.me/..., host:port, or host:port:secret');
  }

  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error('Invalid proxy address');
  }

  const isMtproxy = (
    (url.protocol === 'tg:' && url.hostname === 'proxy')
    || (url.protocol === 'https:' && url.hostname === 't.me' && url.pathname === '/proxy')
  );
  const isSocks = (
    (url.protocol === 'tg:' && url.hostname === 'socks')
    || (url.protocol === 'https:' && url.hostname === 't.me' && url.pathname === '/socks')
  );

  if (!isMtproxy && !isSocks) {
    throw new Error('Proxy address must be tg://proxy, tg://socks, https://t.me/proxy or https://t.me/socks');
  }

  const proxyType = isMtproxy ? 'mtproxy' : 'socks5';
  const proxyHost = trimToEmpty(url.searchParams.get('server'));
  const proxyPort = trimToEmpty(url.searchParams.get('port'));

  if (!proxyHost || !proxyPort) {
    throw new Error('Proxy address is missing server or port');
  }

  return {
    proxyType,
    proxyHost,
    proxyPort,
    proxyUsername: trimToEmpty(url.searchParams.get('user')),
    proxyPassword: trimToEmpty(url.searchParams.get('pass')),
    proxySecret: trimToEmpty(url.searchParams.get('secret'))
  };
}

function buildCompactProxyAddress(config = {}) {
  const proxyType = normalizeProxyType(config.proxyType);
  const host = trimToEmpty(config.proxyHost);
  const port = trimToEmpty(config.proxyPort);
  if (proxyType === 'none' || !host || !port) {
    return '';
  }
  if (proxyType === 'mtproxy') {
    const secret = trimToEmpty(config.proxySecret);
    return secret ? `${host}:${port}:${secret}` : `${host}:${port}`;
  }
  return `${host}:${port}`;
}

function summarizeProxy(config = {}) {
  return {
    type: normalizeProxyType(config.proxyType),
    host: trimToEmpty(config.proxyHost),
    port: trimToEmpty(config.proxyPort),
    configured: normalizeProxyType(config.proxyType) !== 'none' && Boolean(trimToEmpty(config.proxyHost) && trimToEmpty(config.proxyPort))
  };
}

module.exports = {
  BOT_CONNECTOR_SYNC_KEYS,
  MTProtoConfigKeys,
  buildCompactProxyAddress,
  buildProxyConfig,
  buildProxyLink,
  ensureDefaults,
  getConfigSnapshot,
  parseBool,
  parseNumber,
  parseProxyLink,
  summarizeProxy,
  trimToEmpty
};
