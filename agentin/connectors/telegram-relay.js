'use strict';

const path = require('path');
const { createRequire } = require('module');
const telegramPluginRequire = createRequire(path.join(__dirname, '..', 'plugins', 'telegram-relay', 'package.json'));

let bot = null;
let activeContext = null;
let modelChoiceByToken = new Map();

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeChatId(chatId) {
  return String(chatId || '').trim();
}

function duplicateEnabled(context) {
  return parseBool(context.getConfig('duplicateTelegramChat'), true);
}

function buildChannelMeta(msg, contentType = 'text') {
  return {
    channel: 'telegram',
    chatId: normalizeChatId(msg?.chat?.id),
    messageId: msg?.message_id || null,
    username: msg?.from?.username || '',
    contentType
  };
}

function splitLongMessage(text, maxLen = 3900) {
  const source = String(text || '');
  if (source.length <= maxLen) return [source];
  const chunks = [];
  for (let i = 0; i < source.length; i += maxLen) {
    chunks.push(source.slice(i, i + maxLen));
  }
  return chunks;
}

async function sendTelegramText(chatId, text, extra = {}) {
  if (!bot) throw new Error('Telegram bot is not running');
  const chunks = splitLongMessage(text);
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, extra);
  }
}

async function appendLocalSystemError(context, msg, sessionId, errorMessage) {
  try {
    await context.chat.appendMessage({
      sessionId,
      role: 'system',
      content: `Telegram transport error: ${errorMessage}`,
      hidden: false,
      channelMeta: buildChannelMeta(msg, 'system'),
      metadata: {
        source: 'telegram_send_error'
      }
    });
  } catch (error) {
    context.log(`Failed to persist Telegram error in local chat: ${error.message}`);
  }
}

async function ensureOwner(context, msg) {
  if (!msg?.chat || String(msg.chat.type || '') !== 'private') {
    await sendTelegramText(msg.chat.id, 'This personal bot currently accepts private chat messages only.');
    return { ok: false };
  }

  const incomingChatId = normalizeChatId(msg.chat.id);
  const ownerChatId = normalizeChatId(context.getConfig('ownerChatId'));
  if (!ownerChatId) {
    await context.setConfig('ownerChatId', incomingChatId);
    return { ok: true, ownerChatId: incomingChatId, newlyBound: true };
  }

  if (ownerChatId !== incomingChatId) {
    await sendTelegramText(msg.chat.id, 'This bot is configured as a personal bot and is not available for this chat.');
    return { ok: false, ownerChatId };
  }

  return { ok: true, ownerChatId };
}

function parseModelArg(text) {
  const trimmed = String(text || '').trim();
  const parts = trimmed.split(/\s+/g);
  if (parts.length < 2) return null;
  const value = parts.slice(1).join(' ').trim();
  if (!value) return null;

  if (value.includes(':')) {
    const [provider, ...rest] = value.split(':');
    const model = rest.join(':').trim();
    if (!provider.trim() || !model) return null;
    return { provider: provider.trim().toLowerCase(), model };
  }

  return { provider: '', model: value };
}

function parseContextValue(raw) {
  const text = String(raw || '').trim().toLowerCase();
  const map = {
    '8k': 8192,
    '16k': 16384,
    '32k': 32768,
    '64k': 65536
  };
  if (map[text]) return map[text];
  const direct = Number.parseInt(text, 10);
  return Number.isFinite(direct) ? direct : null;
}

function buildProviderKeyboard(providers = [], prefix = 'provider') {
  const buttons = providers.map((provider) => ({
    text: provider,
    callback_data: `tg:${prefix}:${provider}`
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) {
    rows.push(buttons.slice(i, i + 3));
  }
  return { inline_keyboard: rows };
}

function buildModelKeyboard(provider, models = []) {
  modelChoiceByToken = new Map();
  const buttons = models.slice(0, 40).map((model) => {
    const token = Math.random().toString(36).slice(2, 10);
    modelChoiceByToken.set(token, { provider, model });
    return {
      text: model.length > 36 ? `${model.slice(0, 33)}...` : model,
      callback_data: `tg:modelpick:${token}`
    };
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return { inline_keyboard: rows };
}

async function handleProviderSelection(context, msg) {
  const providers = await context.models.listProviders();
  if (!providers.length) {
    await sendTelegramText(msg.chat.id, 'No providers are available right now.');
    return;
  }
  await sendTelegramText(msg.chat.id, 'Pick a provider:', {
    reply_markup: buildProviderKeyboard(providers, 'provider')
  });
}

async function handleModelSelection(context, msg, direct = null) {
  if (direct?.provider && direct?.model) {
    await context.models.setGlobal(direct.provider, direct.model);
    await sendTelegramText(msg.chat.id, `Global model updated: ${direct.provider}:${direct.model}`);
    return;
  }

  if (direct?.model && !direct?.provider) {
    const current = await context.models.getGlobal();
    const provider = String(current.provider || '').trim();
    if (!provider) {
      await sendTelegramText(msg.chat.id, 'Provider is not set. Use /provider or /model and select provider first.');
      return;
    }
    await context.models.setGlobal(provider, direct.model);
    await sendTelegramText(msg.chat.id, `Global model updated: ${provider}:${direct.model}`);
    return;
  }

  const providers = await context.models.listProviders();
  if (!providers.length) {
    await sendTelegramText(msg.chat.id, 'No providers are available right now.');
    return;
  }
  await sendTelegramText(msg.chat.id, 'Choose provider for /model:', {
    reply_markup: buildProviderKeyboard(providers, 'modelprov')
  });
}

async function handleStatus(context, msg) {
  const global = await context.models.getGlobal();
  const sessionInfo = await context.chat.getSession({
    channel: 'telegram',
    chatId: normalizeChatId(msg.chat.id)
  });

  const summary = [
    `Provider: ${global.provider || 'n/a'}`,
    `Model: ${global.model || 'n/a'}`,
    `Session: ${sessionInfo.sessionId || 'n/a'}`,
    `Reading: ${parseBool(context.getConfig('telegramReadingEnabled'), false) ? 'on' : 'off'}`,
    `Duplicate: ${duplicateEnabled(context) ? 'on' : 'off'}`,
    `Owner chat: ${normalizeChatId(context.getConfig('ownerChatId')) || 'not bound'}`
  ].join('\n');
  await sendTelegramText(msg.chat.id, summary);
}

async function handleCommand(context, msg, text) {
  const lower = text.toLowerCase();

  if (lower === '/start') {
    await sendTelegramText(msg.chat.id, 'Telegram relay is active. Send text to chat with LocalAgent.');
    return true;
  }

  if (lower === '/help') {
    await sendTelegramText(
      msg.chat.id,
      [
        'Commands:',
        '/provider',
        '/model [provider:model]',
        '/newBotChat',
        '/clearBotChat',
        '/status',
        '/whoami',
        '/duplicate on|off',
        '/thinking on|off',
        '/context 8k|16k|32k|64k',
        '/stop'
      ].join('\n')
    );
    return true;
  }

  if (lower === '/provider') {
    await handleProviderSelection(context, msg);
    return true;
  }

  if (lower.startsWith('/model')) {
    await handleModelSelection(context, msg, parseModelArg(text));
    return true;
  }

  if (lower === '/newbotchat') {
    const created = await context.chat.newSession({
      channel: 'telegram',
      chatId: normalizeChatId(msg.chat.id)
    });
    await sendTelegramText(msg.chat.id, `Started a new bot chat session: ${created.sessionId}`);
    return true;
  }

  if (lower === '/clearbotchat') {
    const result = await context.chat.clearSession({
      channel: 'telegram',
      chatId: normalizeChatId(msg.chat.id)
    });
    await sendTelegramText(msg.chat.id, `Cleared current bot chat session: ${result.sessionId}`);
    return true;
  }

  if (lower === '/status') {
    await handleStatus(context, msg);
    return true;
  }

  if (lower === '/whoami') {
    const owner = normalizeChatId(context.getConfig('ownerChatId'));
    const lines = [
      `Chat ID: ${msg.chat.id}`,
      `Username: @${msg.from?.username || 'unknown'}`,
      `Bot: @${(await bot.getMe()).username || 'unknown'}`,
      `Owner bound: ${owner ? 'yes' : 'no'}${owner ? ` (${owner})` : ''}`
    ];
    await sendTelegramText(msg.chat.id, lines.join('\n'));
    return true;
  }

  if (lower.startsWith('/duplicate')) {
    const next = lower.endsWith('on');
    const off = lower.endsWith('off');
    if (!next && !off) {
      await sendTelegramText(msg.chat.id, 'Usage: /duplicate on|off');
      return true;
    }
    await context.setConfig('duplicateTelegramChat', next ? 'true' : 'false');
    await sendTelegramText(msg.chat.id, `Duplicate mode is now ${next ? 'ON' : 'OFF'}.`);
    return true;
  }

  if (lower.startsWith('/thinking')) {
    const enabled = lower.endsWith('on');
    const disabled = lower.endsWith('off');
    if (!enabled && !disabled) {
      await sendTelegramText(msg.chat.id, 'Usage: /thinking on|off');
      return true;
    }
    await context.settings.setThinking(enabled ? 'think' : 'off');
    await sendTelegramText(msg.chat.id, `Thinking mode set to ${enabled ? 'ON' : 'OFF'}.`);
    return true;
  }

  if (lower.startsWith('/context')) {
    const parts = text.split(/\s+/g);
    const value = parseContextValue(parts[1] || '');
    if (!value) {
      await sendTelegramText(msg.chat.id, 'Usage: /context 8k|16k|32k|64k');
      return true;
    }
    await context.settings.setContextWindow(value);
    await sendTelegramText(msg.chat.id, `Context window set to ${value}.`);
    return true;
  }

  if (lower === '/stop') {
    await context.control.stopGeneration();
    await sendTelegramText(msg.chat.id, 'Stopped current generation.');
    return true;
  }

  return false;
}

function extractUserText(msg) {
  if (msg.text && String(msg.text).trim()) {
    return { text: String(msg.text).trim(), contentType: 'text', fallbackNotice: '' };
  }

  if (msg.caption && String(msg.caption).trim()) {
    return {
      text: String(msg.caption).trim(),
      contentType: 'caption',
      fallbackNotice: 'Using media caption text (OCR/STT hooks are not configured yet).'
    };
  }

  if (msg.voice) {
    return {
      text: 'Voice message received (STT hook unavailable).',
      contentType: 'voice',
      fallbackNotice: 'Voice message received, but STT hook is unavailable in this setup.'
    };
  }

  if (msg.photo || msg.document || msg.audio || msg.video || msg.video_note) {
    return {
      text: 'Media message received (OCR/STT hook unavailable).',
      contentType: 'media',
      fallbackNotice: 'Media received, but OCR/STT hook is unavailable in this setup.'
    };
  }

  return {
    text: '',
    contentType: 'unknown',
    fallbackNotice: 'Only text messages are fully supported right now.'
  };
}

async function processInboundMessage(context, msg) {
  const ownership = await ensureOwner(context, msg);
  if (!ownership.ok) return;

  const extracted = extractUserText(msg);
  const text = extracted.text;
  const contentType = extracted.contentType;

  if (!text) {
    await sendTelegramText(msg.chat.id, extracted.fallbackNotice || 'No usable text found in message.');
    const resolved = await context.chat.getSession({
      channel: 'telegram',
      chatId: normalizeChatId(msg.chat.id)
    });
    await context.chat.appendMessage({
      sessionId: resolved.sessionId,
      role: 'system',
      content: extracted.fallbackNotice || 'Ignored unsupported message type.',
      hidden: duplicateEnabled(context) !== true,
      channelMeta: buildChannelMeta(msg, contentType),
      metadata: { source: 'telegram_non_text_notice' }
    });
    return;
  }

  if (msg.text && msg.text.startsWith('/')) {
    const handled = await handleCommand(context, msg, msg.text);
    if (handled) return;
  }

  if (extracted.fallbackNotice) {
    await sendTelegramText(msg.chat.id, extracted.fallbackNotice);
  }

  await bot.sendChatAction(msg.chat.id, 'typing');
  const reply = await context.chat.requestReply({
    text,
    duplicate: duplicateEnabled(context),
    channelMeta: buildChannelMeta(msg, contentType)
  });

  if (!reply?.success) {
    await sendTelegramText(msg.chat.id, `Error: ${reply?.error || 'Unable to process the message.'}`);
    return;
  }

  try {
    await sendTelegramText(msg.chat.id, reply.content || 'No response content.');
  } catch (error) {
    await appendLocalSystemError(context, msg, reply.sessionId, error.message || String(error));
    throw error;
  }
}

async function processCallbackQuery(context, query) {
  const data = String(query.data || '');
  const chatId = query?.message?.chat?.id;
  if (!data.startsWith('tg:') || !chatId) {
    return;
  }

  const owner = normalizeChatId(context.getConfig('ownerChatId'));
  const incomingChatId = normalizeChatId(chatId);
  if (!owner) {
    await context.setConfig('ownerChatId', incomingChatId);
  } else if (owner !== incomingChatId) {
    await bot.answerCallbackQuery(query.id, { text: 'This personal bot is not available for this chat.' });
    return;
  }

  if (data.startsWith('tg:provider:')) {
    await bot.answerCallbackQuery(query.id);
    const provider = data.slice('tg:provider:'.length);
    const models = await context.models.listModels(provider);
    if (!models.length) {
      await sendTelegramText(chatId, `No models found for provider "${provider}".`);
      return;
    }
    await sendTelegramText(chatId, `Models for ${provider}:`, {
      reply_markup: buildModelKeyboard(provider, models)
    });
    return;
  }

  if (data.startsWith('tg:modelprov:')) {
    await bot.answerCallbackQuery(query.id);
    const provider = data.slice('tg:modelprov:'.length);
    const models = await context.models.listModels(provider);
    if (!models.length) {
      await sendTelegramText(chatId, `No models found for provider "${provider}".`);
      return;
    }
    await sendTelegramText(chatId, `Pick model for ${provider}:`, {
      reply_markup: buildModelKeyboard(provider, models)
    });
    return;
  }

  if (data.startsWith('tg:modelpick:')) {
    await bot.answerCallbackQuery(query.id);
    const token = data.slice('tg:modelpick:'.length);
    const picked = modelChoiceByToken.get(token);
    if (!picked) {
      await sendTelegramText(chatId, 'Model selection expired. Run /model again.');
      return;
    }
    await context.models.setGlobal(picked.provider, picked.model);
    await sendTelegramText(chatId, `Global model updated: ${picked.provider}:${picked.model}`);
  }
}

module.exports = {
  name: 'telegram-relay',
  description: 'Telegram personal bot relay with session-aware LocalAgent routing',

  configSchema: {
    botToken: { type: 'string', required: true, description: 'Telegram Bot token from @BotFather' },
    telegramReadingEnabled: { type: 'string', required: false, description: 'true/false toggle for polling' },
    duplicateTelegramChat: { type: 'string', required: false, description: 'true/false duplicate to visible chat' },
    ownerChatId: { type: 'string', required: false, description: 'Bound owner chat id' }
  },

  async start(context) {
    activeContext = context;
    const readingEnabled = parseBool(context.getConfig('telegramReadingEnabled'), false);
    if (!readingEnabled) {
      context.log('telegramReadingEnabled=false; connector idle');
      return;
    }

    const token = String(context.getConfig('botToken') || '').trim();
    if (!token) {
      throw new Error('botToken is required');
    }

    let TelegramBot;
    try {
      TelegramBot = telegramPluginRequire('node-telegram-bot-api');
    } catch (error) {
      throw new Error('Telegram plugin runtime is not installed. Run: npm install --omit=dev --prefix agentin/plugins/telegram-relay');
    }

    bot = new TelegramBot(token, {
      polling: {
        autoStart: true,
        interval: 1000
      }
    });

    bot.on('message', async (msg) => {
      try {
        await processInboundMessage(context, msg);
      } catch (error) {
        context.log(`Message handling error: ${error.message}`);
        try {
          await sendTelegramText(msg.chat.id, 'Failed to process your message. See local chat logs for details.');
        } catch (_) {}
      }
    });

    bot.on('callback_query', async (query) => {
      try {
        await processCallbackQuery(context, query);
      } catch (error) {
        context.log(`Callback handling error: ${error.message}`);
        try {
          await bot.answerCallbackQuery(query.id, { text: 'Action failed.' });
        } catch (_) {}
      }
    });

    bot.on('polling_error', (error) => {
      context.log(`Polling error: ${error.message}`);
    });

    const me = await bot.getMe();
    context.log(`Telegram relay started as @${me.username || 'unknown'}`);
  },

  async stop() {
    modelChoiceByToken = new Map();
    if (bot) {
      await bot.stopPolling();
      bot = null;
    }
    activeContext = null;
  }
};
