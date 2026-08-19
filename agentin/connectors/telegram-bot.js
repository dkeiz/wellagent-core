/**
 * Telegram Bot Connector (pre-built)
 * 
 * Routes Telegram messages through the LLM pipeline.
 * Requires: npm install node-telegram-bot-api
 * Config: botToken (required), allowedUsers (optional, comma-separated usernames)
 */

const path = require('path');
const { createRequire } = require('module');
const telegramPluginRequire = createRequire(path.join(__dirname, '..', 'plugins', 'telegram-relay', 'package.json'));

let bot = null;

module.exports = {
    name: 'telegram-bot',
    description: 'Telegram bot that relays messages through the AI agent',

    configSchema: {
        botToken: { type: 'string', required: true, description: 'Telegram Bot API token from @BotFather' },
        allowedUsers: { type: 'string', required: false, description: 'Comma-separated Telegram usernames allowed to use the bot (leave empty for all)' }
    },

    async start(context) {
        const token = context.config.botToken;
        if (!token) {
            throw new Error('botToken is required. Get one from @BotFather on Telegram.');
        }

        context.log('Starting Telegram bot...');

        // Try to load the library
        let TelegramBot;
        try {
            TelegramBot = telegramPluginRequire('node-telegram-bot-api');
        } catch (e) {
            throw new Error('Telegram plugin runtime is not installed. Run: npm install --omit=dev --prefix agentin/plugins/telegram-relay');
        }

        // Parse allowed users
        const allowedUsers = context.config.allowedUsers
            ? context.config.allowedUsers.split(',').map(u => u.trim().replace('@', '').toLowerCase())
            : null; // null = allow all

        // Create bot with polling
        bot = new TelegramBot(token, { polling: true });

        context.log(`Telegram bot started${allowedUsers ? ` (allowed: ${allowedUsers.join(', ')})` : ' (all users)'}`);

        bot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            const username = (msg.from.username || '').toLowerCase();
            const text = msg.text;

            if (!text) return; // Ignore non-text messages

            // Check user permission
            if (allowedUsers && !allowedUsers.includes(username)) {
                context.log(`Blocked message from @${username}: not in allowed list`);
                await bot.sendMessage(chatId, '⛔ You are not authorized to use this bot.');
                return;
            }

            context.log(`Message from @${username}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);

            try {
                // Send "typing" indicator
                await bot.sendChatAction(chatId, 'typing');

                // Invoke LLM through the agent pipeline
                const prompt = `[Telegram from @${username}]: ${text}`;
                const response = await context.invoke(prompt);

                // Send response back to Telegram
                // Split long messages (Telegram limit is 4096 chars)
                const maxLen = 4000;
                if (response.length <= maxLen) {
                    await bot.sendMessage(chatId, response);
                } else {
                    // Split into chunks
                    for (let i = 0; i < response.length; i += maxLen) {
                        await bot.sendMessage(chatId, response.substring(i, i + maxLen));
                    }
                }

                context.log(`Replied to @${username} (${response.length} chars)`);
            } catch (error) {
                context.log(`Error processing message: ${error.message}`);
                await bot.sendMessage(chatId, '❌ Sorry, I encountered an error processing your message.');
            }
        });

        bot.on('polling_error', (error) => {
            context.log(`Polling error: ${error.message}`);
        });
    },

    async stop() {
        if (bot) {
            await bot.stopPolling();
            bot = null;
        }
    }
};
