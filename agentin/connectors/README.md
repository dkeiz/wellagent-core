# Connectors

External service integrations that run as worker threads.

## How It Works

Each `.js` file here (except `_`-prefixed) is a loadable connector. The agent can create, start, stop, and modify connectors.

## Connector Interface

```javascript
module.exports = {
    name: 'connector-name',
    description: 'What it does',
    configSchema: {
        apiToken: { type: 'string', required: true, description: 'Token' }
    },
    async start(context) {
        // context.invoke(prompt) → LLM response
        // context.config → stored config (from DB)
        // context.log(msg) → visible in UI logs
    },
    async stop() { /* cleanup */ }
};
```

## Config

API keys and secrets are stored in the database, NOT in the JS file. Use `connector_config` tool to set values.

## Pre-built

- `telegram-bot.js` — Telegram relay (needs `node-telegram-bot-api`)

## Template

See `_template.js` for a starter file.
