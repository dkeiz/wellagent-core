// @ts-nocheck
const { workerData, parentPort } = require('worker_threads');

/**
 * Connector Worker - runs inside a worker_thread
 * 
 * Loads a connector script, provides it a context object for
 * invoking the LLM, accessing config, and logging.
 */

const { scriptPath, config, connectorName } = workerData;

const pendingRequests = new Map();
let requestCounter = 0;

function rpc(op, payload = {}) {
    return new Promise((resolve, reject) => {
        const requestId = `${Date.now()}-${++requestCounter}`;
        pendingRequests.set(requestId, { resolve, reject });

        parentPort.postMessage({
            type: 'rpc',
            op,
            requestId,
            payload
        });

        setTimeout(() => {
            const pending = pendingRequests.get(requestId);
            if (!pending) return;
            pendingRequests.delete(requestId);
            pending.reject(new Error(`RPC timeout for ${op}`));
        }, 120000);
    });
}

// Context object provided to the connector's start() function
const context = {
    config,
    connectorName,

    /**
     * Invoke the LLM pipeline with a prompt. Returns the response string.
     */
    async invoke(prompt) {
        return rpc('invoke', { prompt: String(prompt || '') });
    },

    getConfig(key) {
        if (typeof key === 'undefined') {
            return { ...config };
        }
        return config[String(key)] ?? '';
    },

    async setConfig(key, value) {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey) {
            throw new Error('Config key is required');
        }
        const normalizedValue = value == null ? '' : String(value);
        await rpc('config:set', {
            key: normalizedKey,
            value: normalizedValue
        });
        config[normalizedKey] = normalizedValue;
        return { key: normalizedKey, value: normalizedValue };
    },

    /**
     * Log a message (visible in connector logs in UI)
     */
    log(message) {
        parentPort.postMessage({ type: 'log', message: String(message) });
    },

    chat: {
        requestReply(payload = {}) {
            return rpc('chat:request-reply', payload || {});
        },
        newSession(payload = {}) {
            return rpc('chat:new-session', payload || {});
        },
        getSession(payload = {}) {
            return rpc('chat:get-session', payload || {});
        },
        clearSession(payload = {}) {
            return rpc('chat:clear-session', payload || {});
        },
        appendMessage(payload = {}) {
            return rpc('chat:append-message', payload || {});
        }
    },

    models: {
        listProviders() {
            return rpc('models:list-providers', {});
        },
        listModels(provider) {
            return rpc('models:list-models', { provider: String(provider || '') });
        },
        setGlobal(provider, model) {
            return rpc('models:set-global', {
                provider: String(provider || ''),
                model: String(model || '')
            });
        },
        getGlobal() {
            return rpc('models:get-global', {});
        }
    },

    settings: {
        setThinking(mode) {
            return rpc('settings:set-thinking', { mode: String(mode || '') });
        },
        setContextWindow(tokens) {
            return rpc('settings:set-context-window', { tokens });
        }
    },

    control: {
        stopGeneration() {
            return rpc('control:stop-generation', {});
        }
    }
};

// Handle responses from main process
parentPort.on('message', async (msg) => {
    switch (msg.type) {
        case 'rpc-response':
            const pending = pendingRequests.get(msg.requestId);
            if (pending) {
                pendingRequests.delete(msg.requestId);
                if (msg.error) {
                    pending.reject(new Error(msg.error));
                } else {
                    pending.resolve(msg.result);
                }
            }
            break;

        case 'stop':
            // Call connector's stop() if available
            try {
                if (connectorModule && typeof connectorModule.stop === 'function') {
                    await connectorModule.stop();
                }
            } catch (e) {
                parentPort.postMessage({ type: 'error', error: `Stop error: ${e.message}` });
            }
            process.exit(0);
            break;
    }
});

// Load and start the connector
let connectorModule;

async function main() {
    try {
        // Dynamic require of the connector script
        connectorModule = require(scriptPath);

        if (typeof connectorModule.start !== 'function') {
            throw new Error('Connector must export a start(context) function');
        }

        // Send metadata to main process
        parentPort.postMessage({
            type: 'started',
            meta: {
                name: connectorModule.name || connectorName,
                description: connectorModule.description || '',
                configSchema: connectorModule.configSchema || {}
            }
        });

        // Start the connector
        await connectorModule.start(context);

    } catch (error) {
        parentPort.postMessage({
            type: 'start-failed',
            error: error.message
        });
        process.exit(1);
    }
}

main();
