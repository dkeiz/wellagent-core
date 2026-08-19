'use strict';

const CONNECTOR_NAME = 'telegram-relay';
const {
  BOT_CONNECTOR_SYNC_KEYS,
  MTProtoConfigKeys,
  buildProxyLink,
  ensureDefaults,
  getConfigSnapshot,
  parseBool,
  parseProxyLink
} = require('./lib/config');
const mtproto = require('./lib/mtproto-runtime');

async function setConnectorConfig(context, key, value) {
  try {
    await context.connectors.setConfig(CONNECTOR_NAME, key, value == null ? '' : String(value));
  } catch (error) {
    context.log(`Connector config sync skipped for ${key}: ${error.message}`);
  }
}

async function syncPluginConfigToConnector(context) {
  const config = getConfigSnapshot(context);
  await setConnectorConfig(context, 'botToken', config.botToken || '');
  await setConnectorConfig(context, 'telegramReadingEnabled', config.telegramReadingEnabled ? 'true' : 'false');
  await setConnectorConfig(context, 'duplicateTelegramChat', config.duplicateTelegramChat ? 'true' : 'false');
  await setConnectorConfig(context, 'ownerChatId', config.ownerChatId || '');
}

async function isConnectorRunning(context) {
  const list = await context.connectors.list();
  const current = list.find((item) => item.name === CONNECTOR_NAME);
  return String(current?.status || '').toLowerCase() === 'running';
}

async function ensureStopped(context) {
  if (!(await isConnectorRunning(context))) return;
  try {
    await context.connectors.stop(CONNECTOR_NAME);
  } catch (error) {
    context.log(`Stop connector warning: ${error.message}`);
  }
}

async function ensureStarted(context) {
  const botToken = String(context.getConfig('botToken') || '').trim();
  if (!botToken) {
    context.log('Telegram reading requested but botToken is empty');
    return { success: false, error: 'botToken is required' };
  }
  if (await isConnectorRunning(context)) {
    return { success: true, running: true };
  }
  return context.connectors.start(CONNECTOR_NAME);
}

async function applyReadingState(context) {
  const readingEnabled = parseBool(context.getConfig('telegramReadingEnabled'), false);
  if (!readingEnabled) {
    await ensureStopped(context);
    return { success: true, running: false };
  }
  return ensureStarted(context);
}

async function persistMtprotoSession(context, payload) {
  const me = payload?.me || null;
  const identity = mtproto.formatIdentity(me);
  await context.setConfig('sessionString', payload?.sessionString || '');
  await context.setConfig('mtprotoPhoneCodeHash', '');
  await context.setConfig('mtprotoPendingPhoneNumber', '');
  await context.setConfig('mtprotoLastAuthUser', identity);
  await context.setConfig('mtprotoLastAuthAt', new Date().toISOString());
  await context.setConfig('mtprotoEnabled', 'true');
}

async function buildPluginStatus(context) {
  const config = getConfigSnapshot(context);
  const running = await isConnectorRunning(context);
  return {
    success: true,
    connector: CONNECTOR_NAME,
    readingEnabled: config.telegramReadingEnabled,
    duplicateTelegramChat: config.duplicateTelegramChat,
    ownerChatId: config.ownerChatId,
    running,
    mtproto: {
      ...mtproto.buildStatus(config),
      proxyLink: (() => {
        try {
          return buildProxyLink(config);
        } catch (_) {
          return '';
        }
      })()
    }
  };
}

module.exports = {
  async onEnable(context) {
    await ensureDefaults(context);
    await syncPluginConfigToConnector(context);
    await applyReadingState(context);

    context.registerHandler('send_direct', {
      description: 'Send a direct Telegram message through the saved MTProto session. Uses defaultPeer if peer is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: 'Optional @username, phone, or dialog. Falls back to defaultPeer.' },
          message: { type: 'string', description: 'Message text to send' }
        },
        required: ['message']
      }
    }, async (params = {}) => {
      const config = getConfigSnapshot(context);
      return mtproto.sendDirectMessage(config, params);
    });

    context.registerHandler('status', {
      description: 'Return classic Telegram relay and MTProto transport status for this plugin',
      inputSchema: { type: 'object', properties: {} }
    }, async () => buildPluginStatus(context));

    context.log('Telegram plugin enabled');
  },

  async onDisable(context) {
    if (context) {
      await ensureStopped(context);
    }
    await mtproto.invalidateRuntime();
  },

  async onConfigChanged(key, value, context) {
    if (BOT_CONNECTOR_SYNC_KEYS.includes(key)) {
      await setConnectorConfig(context, key, value);
    }
    if (MTProtoConfigKeys.includes(key)) {
      await mtproto.invalidateRuntime();
    }

    if (key === 'telegramReadingEnabled') {
      await applyReadingState(context);
      return;
    }

    if (key === 'botToken') {
      const readingEnabled = parseBool(context.getConfig('telegramReadingEnabled'), false);
      if (readingEnabled) {
        await ensureStopped(context);
        await ensureStarted(context);
      }
    }
  },

  async runAction(action, params = {}, context) {
    if (action === 'discover' || action === 'status') {
      return buildPluginStatus(context);
    }

    if (action === 'start-reading') {
      await context.setConfig('telegramReadingEnabled', 'true');
      return applyReadingState(context);
    }

    if (action === 'stop-reading') {
      await context.setConfig('telegramReadingEnabled', 'false');
      return applyReadingState(context);
    }

    if (action === 'set-owner') {
      const ownerChatId = String(params.chatId || params.ownerChatId || '').trim();
      await context.setConfig('ownerChatId', ownerChatId);
      await setConnectorConfig(context, 'ownerChatId', ownerChatId);
      return { success: true, ownerChatId };
    }

    if (action === 'mtproto-request-code') {
      const config = getConfigSnapshot(context);
      const result = await mtproto.requestLoginCode(config, params);
      await context.setConfig('mtprotoPhoneCodeHash', result.phoneCodeHash || '');
      await context.setConfig('mtprotoPendingPhoneNumber', result.phoneNumber || config.phoneNumber || '');
      return result;
    }

    if (action === 'mtproto-login') {
      const config = getConfigSnapshot(context);
      const result = await mtproto.completeUserLogin(config, params);
      if (result?.success !== true) {
        return result;
      }
      await persistMtprotoSession(context, result);
      return result;
    }

    if (action === 'mtproto-login-bot') {
      const config = getConfigSnapshot(context);
      const result = await mtproto.completeBotLogin(config);
      await persistMtprotoSession(context, result);
      return result;
    }

    if (action === 'mtproto-clear-session') {
      await context.setConfig('sessionString', '');
      await context.setConfig('mtprotoPhoneCodeHash', '');
      await context.setConfig('mtprotoPendingPhoneNumber', '');
      await context.setConfig('mtprotoLastAuthUser', '');
      await context.setConfig('mtprotoLastAuthAt', '');
      await context.setConfig('mtprotoEnabled', 'false');
      await mtproto.invalidateRuntime();
      return { success: true, cleared: true };
    }

    if (action === 'mtproto-test') {
      const config = getConfigSnapshot(context);
      return mtproto.testSession(config);
    }

    if (action === 'mtproto-send') {
      const config = getConfigSnapshot(context);
      return mtproto.sendDirectMessage(config, params);
    }

    if (action === 'build-proxy-link') {
      const config = getConfigSnapshot(context);
      return {
        success: true,
        proxyLink: buildProxyLink(config)
      };
    }

    if (action === 'apply-proxy-link') {
      const parsed = parseProxyLink(params.link || params.proxyLink || '');
      await context.setConfig('proxyType', parsed.proxyType);
      await context.setConfig('proxyHost', parsed.proxyHost);
      await context.setConfig('proxyPort', parsed.proxyPort);
      await context.setConfig('proxyUsername', parsed.proxyUsername || '');
      await context.setConfig('proxyPassword', parsed.proxyPassword || '');
      await context.setConfig('proxySecret', parsed.proxySecret || '');
      return { success: true, ...parsed };
    }

    if (action === 'clear-proxy') {
      await context.setConfig('proxyType', 'none');
      await context.setConfig('proxyHost', '');
      await context.setConfig('proxyPort', '1080');
      await context.setConfig('proxyUsername', '');
      await context.setConfig('proxyPassword', '');
      await context.setConfig('proxySecret', '');
      return { success: true, cleared: true };
    }

    throw new Error(`Unknown plugin action: ${action}`);
  }
};
