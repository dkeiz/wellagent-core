'use strict';

const { buildProxyConfig, summarizeProxy, trimToEmpty } = require('./config');

const RUNTIME = {
  client: null,
  fingerprint: '',
  me: null
};

function loadGramJs() {
  let telegram;
  let sessions;
  try {
    telegram = require('telegram');
    sessions = require('telegram/sessions');
  } catch (error) {
    throw new Error('telegram package is not installed. Run: npm install telegram');
  }

  return {
    Api: telegram.Api,
    TelegramClient: telegram.TelegramClient,
    StringSession: sessions.StringSession
  };
}

function apiCredentials(config = {}) {
  const apiId = Number(config.apiId);
  const apiHash = trimToEmpty(config.apiHash);
  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error('Telegram API ID is required');
  }
  if (!apiHash) {
    throw new Error('Telegram API hash is required');
  }
  return { apiId, apiHash };
}

function buildFingerprint(config = {}) {
  return JSON.stringify({
    mode: trimToEmpty(config.mtprotoMode),
    apiId: trimToEmpty(config.apiId),
    apiHash: trimToEmpty(config.apiHash),
    sessionString: trimToEmpty(config.sessionString),
    proxyType: trimToEmpty(config.proxyType),
    proxyHost: trimToEmpty(config.proxyHost),
    proxyPort: trimToEmpty(config.proxyPort),
    proxyUsername: trimToEmpty(config.proxyUsername),
    proxyPassword: trimToEmpty(config.proxyPassword),
    proxySecret: trimToEmpty(config.proxySecret),
    proxyTimeoutSec: trimToEmpty(config.proxyTimeoutSec)
  });
}

function createClient(config = {}, sessionString = '') {
  const { TelegramClient, StringSession } = loadGramJs();
  const { apiId, apiHash } = apiCredentials(config);
  const proxy = buildProxyConfig(config);
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 2,
    reconnectRetries: 2,
    retryDelay: 800,
    autoReconnect: true,
    proxy: proxy || undefined,
    deviceModel: 'LocalAgent Desktop',
    appVersion: '0.0.1-alpha.1',
    systemVersion: process.platform
  });
}

async function disconnectClient(client) {
  if (!client) return;
  try {
    await client.disconnect();
  } catch (_) {}
  try {
    await client.destroy();
  } catch (_) {}
}

async function invalidateRuntime() {
  if (RUNTIME.client) {
    await disconnectClient(RUNTIME.client);
  }
  RUNTIME.client = null;
  RUNTIME.fingerprint = '';
  RUNTIME.me = null;
}

function simplifyUser(user) {
  if (!user) return null;
  return {
    id: user.id != null ? String(user.id) : '',
    username: trimToEmpty(user.username),
    firstName: trimToEmpty(user.firstName || user.first_name),
    lastName: trimToEmpty(user.lastName || user.last_name),
    phone: trimToEmpty(user.phone),
    bot: user.bot === true
  };
}

function formatIdentity(user) {
  if (!user) return '';
  if (user.username) return `@${user.username}`;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.phone || user.id || '';
}

async function withFreshClient(config, sessionString, work) {
  const client = createClient(config, sessionString);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await disconnectClient(client);
  }
}

async function requestLoginCode(config, params = {}) {
  const phoneNumber = trimToEmpty(params.phoneNumber || config.phoneNumber);
  if (!phoneNumber) {
    throw new Error('Phone number is required');
  }

  const creds = apiCredentials(config);
  return withFreshClient(config, '', async (client) => {
    const result = await client.sendCode(creds, phoneNumber, params.forceSms === true);
    return {
      success: true,
      phoneNumber,
      phoneCodeHash: result.phoneCodeHash,
      isCodeViaApp: result.isCodeViaApp === true
    };
  });
}

async function completeUserLogin(config, params = {}) {
  const { Api } = loadGramJs();
  const creds = apiCredentials(config);
  const phoneNumber = trimToEmpty(params.phoneNumber || config.mtprotoPendingPhoneNumber || config.phoneNumber);
  const phoneCodeHash = trimToEmpty(params.phoneCodeHash || config.mtprotoPhoneCodeHash);
  const phoneCode = trimToEmpty(params.phoneCode);
  const password = trimToEmpty(params.password);

  if (!phoneNumber) throw new Error('Phone number is required');
  if (!phoneCodeHash) throw new Error('Phone code hash is missing. Request a login code first.');
  if (!phoneCode) throw new Error('Telegram login code is required');

  return withFreshClient(config, '', async (client) => {
    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode
      }));
    } catch (error) {
      if (error?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        if (!password) {
          return {
            success: false,
            needPassword: true,
            error: 'Account has 2FA enabled. Enter the Telegram password and try again.'
          };
        }
        await client.signInWithPassword(creds, {
          password: async () => password,
          onError: async (authError) => {
            throw authError;
          }
        });
      } else {
        throw error;
      }
    }

    const me = simplifyUser(await client.getMe());
    return {
      success: true,
      sessionString: client.session.save(),
      me
    };
  });
}

async function completeBotLogin(config) {
  const creds = apiCredentials(config);
  const botToken = trimToEmpty(config.botToken);
  if (!botToken) {
    throw new Error('Bot token is required for MTProto bot login');
  }

  return withFreshClient(config, '', async (client) => {
    await client.signInBot(creds, { botAuthToken: botToken });
    const me = simplifyUser(await client.getMe());
    return {
      success: true,
      sessionString: client.session.save(),
      me
    };
  });
}

async function getRuntimeClient(config) {
  const sessionString = trimToEmpty(config.sessionString);
  if (!sessionString) {
    throw new Error('No MTProto session is saved. Login first.');
  }

  const fingerprint = buildFingerprint(config);
  if (RUNTIME.client && RUNTIME.fingerprint === fingerprint && RUNTIME.client.disconnected !== true) {
    return RUNTIME.client;
  }

  await invalidateRuntime();
  const client = createClient(config, sessionString);
  await client.connect();
  const authorized = await client.checkAuthorization();
  if (!authorized) {
    await disconnectClient(client);
    throw new Error('Saved MTProto session is not authorized. Login again.');
  }

  RUNTIME.client = client;
  RUNTIME.fingerprint = fingerprint;
  RUNTIME.me = simplifyUser(await client.getMe());
  return client;
}

function buildStatus(config = {}) {
  return {
    enabled: config.mtprotoEnabled === true,
    mode: trimToEmpty(config.mtprotoMode) || 'user',
    hasApiId: Boolean(trimToEmpty(config.apiId)),
    hasApiHash: Boolean(trimToEmpty(config.apiHash)),
    hasSession: Boolean(trimToEmpty(config.sessionString)),
    phoneNumber: trimToEmpty(config.phoneNumber),
    defaultPeer: trimToEmpty(config.defaultPeer),
    proxy: summarizeProxy(config),
    lastAuthUser: trimToEmpty(config.mtprotoLastAuthUser),
    lastAuthAt: trimToEmpty(config.mtprotoLastAuthAt),
    runtimeConnected: Boolean(RUNTIME.client)
  };
}

async function testSession(config) {
  if (config.mtprotoEnabled !== true) {
    throw new Error('MTProto mode is disabled');
  }
  const client = await getRuntimeClient(config);
  const me = simplifyUser(await client.getMe());
  RUNTIME.me = me;
  return {
    success: true,
    connected: true,
    me,
    identity: formatIdentity(me),
    proxy: summarizeProxy(config)
  };
}

async function sendDirectMessage(config, params = {}) {
  if (config.mtprotoEnabled !== true) {
    throw new Error('MTProto mode is disabled');
  }

  const peer = trimToEmpty(params.peer || config.defaultPeer);
  const message = String(params.message || '').trim();
  if (!peer) {
    throw new Error('Peer is required');
  }
  if (!message) {
    throw new Error('Message is required');
  }

  const client = await getRuntimeClient(config);
  const sent = await client.sendMessage(peer, { message });
  return {
    success: true,
    peer,
    id: sent?.id ?? null,
    date: sent?.date ?? null
  };
}

module.exports = {
  buildStatus,
  completeBotLogin,
  completeUserLogin,
  formatIdentity,
  invalidateRuntime,
  requestLoginCode,
  sendDirectMessage,
  testSession
};
