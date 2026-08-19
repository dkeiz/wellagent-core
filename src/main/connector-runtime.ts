// @ts-nocheck
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { normalizeConnectorName } = require('./connector-name-policy');
const { buildRuntimePaths } = require('./runtime-paths');
const { normalizeUserId } = require('./user-scope');
const { SECRET_SETTING_REDACTION, isSecretSettingKey } = require('./settings-security');
const { isPathInside, resolveBoundaryPath } = require('./path-boundary');

/**
 * ConnectorRuntime - Manages dynamic connector scripts in worker threads
 *
 * Connectors are shared code files, but every running instance is user-owned.
 */
class ConnectorRuntime extends EventEmitter {
    constructor(dispatcher, db, options = {}) {
        super();
        this.dispatcher = dispatcher;
        this.db = db;
        this.eventBus = options.eventBus || null;
        this.externalChannelBridge = options.externalChannelBridge || null;
        this.connectors = new Map(); // <userId>::<name> -> state
        this.connectorsDir = options.connectorsDir || buildRuntimePaths(options).connectorsDir;
        this.workerPath = path.join(__dirname, 'connector-worker.js');
        this.maxLogs = 100;

        this._ensureDir();
    }

    _ensureDir() {
        if (!fs.existsSync(this.connectorsDir)) {
            fs.mkdirSync(this.connectorsDir, { recursive: true });
        }
    }

    _requireScopeOptions(options = {}, label = 'connector operation') {
        const requestContext = options?.requestContext || null;
        const userId = String(options?.userId || options?.user_id || requestContext?.userId || requestContext?.user_id || '').trim();
        if (!userId) {
            throw new Error(label + ' requires a concrete user');
        }
        return {
            ...options,
            requestContext,
            userId: normalizeUserId(userId, 'localuser')
        };
    }

    _getConnectorInstanceKey(name, userId) {
        return `${normalizeUserId(userId, 'localuser')}::${normalizeConnectorName(name)}`;
    }

    _resolveConnectorIdentity(name, options = {}, label = 'connector operation') {
        const scopeOptions = this._requireScopeOptions(options, label);
        const normalizedName = normalizeConnectorName(name);
        return {
            scopeOptions,
            name: normalizedName,
            instanceKey: this._getConnectorInstanceKey(normalizedName, scopeOptions.userId)
        };
    }

    _assertConnectorScope(connector, scopeOptions, label = 'connector operation') {
        const runtimeUserId = String(connector?.scopeOptions?.userId || '').trim();
        const currentUserId = String(scopeOptions?.userId || '').trim();
        if (runtimeUserId && currentUserId && runtimeUserId !== currentUserId) {
            throw new Error(label + ' is bound to user "' + runtimeUserId + '"');
        }
    }

    _resolveConnectorScriptPath(name) {
        const scriptPath = path.join(this.connectorsDir, `${normalizeConnectorName(name)}.js`);
        if (!fs.existsSync(scriptPath)) {
            throw new Error(`Connector script not found: ${scriptPath}`);
        }
        const realConnectorsDir = resolveBoundaryPath(this.connectorsDir);
        const realScriptPath = resolveBoundaryPath(scriptPath);
        if (!isPathInside(realConnectorsDir, realScriptPath)) {
            throw new Error(`Connector script must stay inside connectors directory: ${name}`);
        }
        return realScriptPath;
    }

    async listConnectors(options = {}) {
        const scopeOptions = this._requireScopeOptions(options, 'connector list');
        const files = fs.readdirSync(this.connectorsDir)
            .filter(f => f.endsWith('.js') && !f.startsWith('_'));

        const results = [];
        for (const file of files) {
            const name = path.basename(file, '.js');
            const connector = this.connectors.get(this._getConnectorInstanceKey(name, scopeOptions.userId));
            const running = connector?.status === 'running';

            let meta = { name, description: '' };
            try {
                const content = fs.readFileSync(path.join(this.connectorsDir, file), 'utf-8');
                const nameMatch = content.match(/name:\s*['"]([^'"]+)['"]/);
                const descMatch = content.match(/description:\s*['"]([^'"]+)['"]/);
                if (nameMatch) meta.name = nameMatch[1];
                if (descMatch) meta.description = descMatch[1];
            } catch (e) { }

            results.push({
                file,
                name: meta.name,
                description: meta.description,
                status: running ? connector.status : 'stopped',
                error: running ? connector.error : null,
                user_id: scopeOptions.userId
            });
        }
        return results;
    }

    async startConnector(name, options = {}) {
        const { scopeOptions, name: normalizedName, instanceKey } = this._resolveConnectorIdentity(name, options, 'connector start');
        const existing = this.connectors.get(instanceKey);
        if (existing?.status === 'running') {
            throw new Error(`Connector "${normalizedName}" is already running`);
        }

        const scriptPath = this._resolveConnectorScriptPath(normalizedName);
        const config = await this._loadConfig(normalizedName, { ...scopeOptions, includeSecrets: true });

        console.log(`[ConnectorRuntime] Starting connector "${normalizedName}" for ${scopeOptions.userId}...`);

        return new Promise((resolve, reject) => {
            const worker = new Worker(this.workerPath, {
                workerData: {
                    scriptPath,
                    config,
                    connectorName: normalizedName
                }
            });

            const connectorState = {
                worker,
                config,
                status: 'starting',
                error: null,
                meta: { name: normalizedName },
                logs: [],
                scopeOptions,
                instanceKey,
                name: normalizedName
            };

            this.connectors.set(instanceKey, connectorState);

            worker.on('message', async (msg) => {
                switch (msg.type) {
                    case 'started':
                        connectorState.status = 'running';
                        connectorState.meta = msg.meta || { name: normalizedName };
                        this._log(instanceKey, normalizedName, `Connector started`);
                        this.emit('connector-started', { name: normalizedName, userId: scopeOptions.userId });
                        this.eventBus?.publish('connector:started', { name: normalizedName, userId: scopeOptions.userId });
                        resolve({ success: true, name: normalizedName, user_id: scopeOptions.userId });
                        break;

                    case 'log':
                        this._log(instanceKey, normalizedName, msg.message);
                        break;

                    case 'invoke':
                        try {
                            const response = await this.dispatcher.dispatch(String(msg.prompt || ''), [], {
                                mode: 'connector',
                                requestContext: connectorState.scopeOptions?.requestContext || null
                            });
                            worker.postMessage({
                                type: 'invoke-response',
                                requestId: msg.requestId,
                                response: response.content
                            });
                        } catch (error) {
                            worker.postMessage({
                                type: 'invoke-response',
                                requestId: msg.requestId,
                                error: error.message
                            });
                        }
                        break;

                    case 'error':
                        connectorState.error = msg.error;
                        this._log(instanceKey, normalizedName, `Error: ${msg.error}`);
                        this.emit('connector-error', { name: normalizedName, userId: scopeOptions.userId, error: msg.error });
                        this.eventBus?.publish('connector:error', { name: normalizedName, userId: scopeOptions.userId, error: msg.error });
                        break;

                    case 'start-failed':
                        connectorState.status = 'error';
                        connectorState.error = msg.error;
                        this._log(instanceKey, normalizedName, `Start failed: ${msg.error}`);
                        reject(new Error(msg.error));
                        break;

                    case 'rpc':
                        await this._handleWorkerRpc(normalizedName, connectorState, worker, msg);
                        break;
                }
            });

            worker.on('error', (error) => {
                connectorState.status = 'error';
                connectorState.error = error.message;
                this._log(instanceKey, normalizedName, `Worker error: ${error.message}`);
                this.emit('connector-error', { name: normalizedName, userId: scopeOptions.userId, error: error.message });
                this.eventBus?.publish('connector:error', { name: normalizedName, userId: scopeOptions.userId, error: error.message });
            });

            worker.on('exit', (code) => {
                connectorState.status = 'stopped';
                connectorState.worker = null;
                this._log(instanceKey, normalizedName, `Worker exited with code ${code}`);
                this.emit('connector-stopped', { name: normalizedName, userId: scopeOptions.userId, code });
                this.eventBus?.publish('connector:stopped', { name: normalizedName, userId: scopeOptions.userId, code });
            });

            setTimeout(() => {
                if (connectorState.status === 'starting') {
                    connectorState.status = 'error';
                    connectorState.error = 'Startup timeout';
                    worker.terminate();
                    reject(new Error('Connector startup timeout (30s)'));
                }
            }, 30000);
        });
    }

    async stopConnector(name, options = {}) {
        const { scopeOptions, name: normalizedName, instanceKey } = this._resolveConnectorIdentity(name, options, 'connector stop');
        const connector = this.connectors.get(instanceKey);
        this._assertConnectorScope(connector, scopeOptions, 'connector stop');
        if (!connector || connector.status !== 'running') {
            throw new Error(`Connector "${normalizedName}" is not running`);
        }

        console.log(`[ConnectorRuntime] Stopping connector "${normalizedName}" for ${scopeOptions.userId}...`);
        connector.worker.postMessage({ type: 'stop' });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (connector.worker) {
                    connector.worker.terminate();
                }
                connector.status = 'stopped';
                this._log(instanceKey, normalizedName, 'Force terminated');
                resolve({ success: true, name: normalizedName, user_id: scopeOptions.userId });
            }, 5000);

            connector.worker.once('exit', () => {
                clearTimeout(timeout);
                connector.status = 'stopped';
                this._log(instanceKey, normalizedName, 'Stopped gracefully');
                resolve({ success: true, name: normalizedName, user_id: scopeOptions.userId });
            });
        });
    }

    async stopAll() {
        const entries = Array.from(this.connectors.values());
        for (const connector of entries) {
            if (connector?.status === 'running') {
                try {
                    await this.stopConnector(connector.name, connector.scopeOptions || {});
                } catch (e) {
                    console.error(`[ConnectorRuntime] Failed to stop "${connector.name}":`, e.message);
                }
            }
        }
    }

    _credentialName(name, key) {
        return `connector.${normalizeConnectorName(name)}.${String(key || '').trim()}`;
    }

    async _loadConfig(name, options = {}) {
        name = normalizeConnectorName(name);
        const config = {};
        const prefix = `connector.${name}.`;
        const settings = await this.db.getAllSettings(options);
        for (const [key, value] of Object.entries(settings)) {
            if (!key.startsWith(prefix)) continue;
            const configKey = key.slice(prefix.length);
            if (isSecretSettingKey(configKey)) {
                const secret = this.db.getCredential
                    ? await this.db.getCredential(this._credentialName(name, configKey), options)
                    : value;
                config[configKey] = options.includeSecrets === true
                    ? (secret || value || '')
                    : (secret || value ? SECRET_SETTING_REDACTION : '');
            } else {
                config[configKey] = value;
            }
        }
        return config;
    }

    async setConfig(name, key, value, options = {}) {
        const { scopeOptions, name: normalizedName, instanceKey } = this._resolveConnectorIdentity(name, options, 'connector config update');
        const settingKey = `connector.${normalizedName}.${key}`;
        const normalizedValue = value == null ? '' : String(value);
        if (isSecretSettingKey(key) && this.db.setCredential) {
            await this.db.setCredential(this._credentialName(normalizedName, key), normalizedValue, scopeOptions);
            await this.db.saveScopedSetting(settingKey, normalizedValue ? SECRET_SETTING_REDACTION : '', scopeOptions);
        } else {
            await this.db.saveScopedSetting(settingKey, normalizedValue, scopeOptions);
        }

        const connector = this.connectors.get(instanceKey);
        if (connector) {
            this._assertConnectorScope(connector, scopeOptions, 'connector config update');
            connector.config[key] = normalizedValue;
        }

        return { success: true, name: normalizedName, key, user_id: scopeOptions.userId };
    }

    async getConfig(name, options = {}) {
        const { scopeOptions, name: normalizedName } = this._resolveConnectorIdentity(name, options, 'connector config read');
        return await this._loadConfig(normalizedName, scopeOptions);
    }

    _log(instanceKey, name, message) {
        const connector = this.connectors.get(instanceKey);
        if (!connector) return;

        const entry = {
            timestamp: new Date().toISOString(),
            message
        };

        connector.logs.push(entry);
        if (connector.logs.length > this.maxLogs) {
            connector.logs.shift();
        }

        console.log(`[Connector:${connector.scopeOptions.userId}:${name}] ${message}`);
        this.emit('connector-log', { name, userId: connector.scopeOptions.userId, ...entry });
    }

    getLogs(name, limit = 50, options = {}) {
        const { scopeOptions, name: normalizedName, instanceKey } = this._resolveConnectorIdentity(name, options, 'connector log read');
        const connector = this.connectors.get(instanceKey);
        this._assertConnectorScope(connector, scopeOptions, 'connector log read');
        if (!connector) return [];
        return connector.logs.slice(-limit);
    }

    async _handleWorkerRpc(name, connectorState, worker, msg = {}) {
        const requestId = msg.requestId;
        const op = String(msg.op || '').trim();
        const payload = msg.payload || {};

        if (!requestId || !op) {
            worker.postMessage({
                type: 'rpc-response',
                requestId,
                error: 'Invalid RPC request'
            });
            return;
        }

        try {
            let result = null;
            if (op === 'invoke') {
                const prompt = String(payload.prompt || '');
                const response = await this.dispatcher.dispatch(prompt, [], {
                    mode: 'connector',
                    requestContext: connectorState.scopeOptions?.requestContext || null
                });
                result = response?.content || '';
            } else if (op === 'config:get') {
                if (payload.key) {
                    result = connectorState.config?.[String(payload.key)] ?? '';
                } else {
                    result = { ...(connectorState.config || {}) };
                }
            } else if (op === 'config:set') {
                if (!payload.key) {
                    throw new Error('config:set requires key');
                }
                const key = String(payload.key);
                const value = payload.value == null ? '' : String(payload.value);
                await this.setConfig(name, key, value, connectorState.scopeOptions || {});
                result = { success: true, key, value };
            } else if (op === 'chat:request-reply') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.requestReply(payload);
            } else if (op === 'chat:new-session') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.newSession(payload);
            } else if (op === 'chat:get-session') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.getSession(payload);
            } else if (op === 'chat:clear-session') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.clearSession(payload);
            } else if (op === 'chat:append-message') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.appendMessage(payload);
            } else if (op === 'models:list-providers') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.listProviders();
            } else if (op === 'models:list-models') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.listModels(payload.provider);
            } else if (op === 'models:set-global') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.setGlobalModel(payload.provider, payload.model);
            } else if (op === 'models:get-global') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.getGlobalModel();
            } else if (op === 'settings:set-thinking') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.setThinkingMode(payload.mode);
            } else if (op === 'settings:set-context-window') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.setContextWindow(payload.tokens);
            } else if (op === 'control:stop-generation') {
                this._assertExternalBridge(op);
                result = await this.externalChannelBridge.stopGeneration();
            } else {
                throw new Error(`Unsupported RPC op: ${op}`);
            }

            worker.postMessage({
                type: 'rpc-response',
                requestId,
                result
            });
        } catch (error) {
            worker.postMessage({
                type: 'rpc-response',
                requestId,
                error: error.message
            });
        }
    }

    _assertExternalBridge(op) {
        if (!this.externalChannelBridge) {
            throw new Error(`Connector RPC "${op}" requires external channel bridge`);
        }
    }
}

module.exports = ConnectorRuntime;
