// @ts-nocheck
const http = require('http');
const { EventEmitter } = require('events');

/**
 * PortListenerManager - Manages HTTP listeners that can invoke the LLM
 * 
 * Features:
 * - Create HTTP listeners on specified ports
 * - Format incoming requests using prompt templates
 * - Invoke agent engine with formatted data
 * - Return LLM response to caller
 */
class PortListenerManager extends EventEmitter {
    constructor(dispatcher) {
        super();
        this.dispatcher = dispatcher;
        this.listeners = new Map(); // port -> { server, config }
        this.maxListeners = 10;
        this.maxRequestSize = 1024 * 100; // 100KB
        this.requestTimeout = 60000; // 60 seconds
    }

    getAllowedCorsOrigin(origin) {
        if (!origin) return '';
        try {
            const parsed = new URL(origin);
            const host = parsed.hostname.toLowerCase();
            if ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
                && (host === 'localhost' || host === '127.0.0.1' || host === '::1')) {
                return origin;
            }
        } catch (_) {}
        return '';
    }

    /**
     * Register a new port listener
     * @param {Object} config - Listener configuration
     * @param {number} config.port - Port to listen on
     * @param {string} config.name - Friendly name for the listener
     * @param {string} config.promptTemplate - Template for formatting requests
     * @param {string} config.method - HTTP method to accept (GET, POST, or ANY)
     */
    async register(config) {
        const { port, name, promptTemplate = '{body}', method = 'POST' } = config;

        if (this.listeners.has(port)) {
            throw new Error(`Port ${port} is already in use by listener: ${this.listeners.get(port).config.name}`);
        }

        if (this.listeners.size >= this.maxListeners) {
            throw new Error(`Maximum number of listeners (${this.maxListeners}) reached`);
        }

        // Validate port range
        if (port < 3000 || port > 65535) {
            throw new Error('Port must be between 3000 and 65535');
        }

        const server = http.createServer(async (req, res) => {
            await this.handleRequest(req, res, config);
        });

        return new Promise((resolve, reject) => {
            server.listen(port, '127.0.0.1', () => {
                console.log(`[PortListener] Started "${name}" on port ${port}`);
                this.listeners.set(port, { server, config });
                this.emit('listener-started', { port, name });
                resolve({ success: true, port, name });
            });

            server.on('error', (error) => {
                console.error(`[PortListener] Failed to start on port ${port}:`, error.message);
                reject(error);
            });
        });
    }

    /**
     * Handle incoming HTTP request
     */
    async handleRequest(req, res, config) {
        const { name, promptTemplate, method } = config;

        const allowedOrigin = this.getAllowedCorsOrigin(req.headers.origin);
        if (allowedOrigin) {
            res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
            res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // Method check
        if (method !== 'ANY' && req.method !== method) {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Method ${req.method} not allowed. Expected ${method}` }));
            return;
        }

        try {
            // Parse request body
            const body = await this.parseBody(req);

            // Format prompt using template
            const prompt = this.formatPrompt(promptTemplate, {
                body: JSON.stringify(body),
                method: req.method,
                url: req.url,
                headers: JSON.stringify(req.headers),
                timestamp: new Date().toISOString()
            });

            console.log(`[PortListener] "${name}" received request, invoking LLM...`);
            this.emit('request-received', { name, body });

            // Invoke LLM
            const response = await this.invokeLLM(prompt);

            // Send response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                response: response.content,
                listener: name
            }));

            this.emit('request-completed', { name, success: true });

        } catch (error) {
            console.error(`[PortListener] "${name}" error:`, error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message,
                listener: name
            }));

            this.emit('request-error', { name, error: error.message });
        }
    }

    /**
     * Parse request body with size limit
     */
    parseBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            let size = 0;
            let settled = false;
            let timer = null;

            const settle = (ok, value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (ok) {
                    resolve(value);
                } else {
                    reject(value);
                }
            };

            req.on('data', chunk => {
                if (settled) return;
                size += chunk.length;
                if (size > this.maxRequestSize) {
                    settle(false, new Error(`Request body exceeds maximum size of ${this.maxRequestSize} bytes`));
                    req.destroy();
                    return;
                }
                body += chunk.toString();
            });

            req.on('end', () => {
                try {
                    if (body && req.headers['content-type']?.includes('application/json')) {
                        settle(true, JSON.parse(body));
                    } else {
                        settle(true, body || {});
                    }
                } catch (error) {
                    settle(true, body); // Return raw string if not valid JSON
                }
            });

            req.on('error', error => settle(false, error));

            timer = setTimeout(() => {
                settle(false, new Error('Request timeout'));
                req.destroy();
            }, this.requestTimeout);
        });
    }

    /**
     * Format prompt using template with placeholders
     */
    formatPrompt(template, data) {
        let prompt = template;
        for (const [key, value] of Object.entries(data)) {
            prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        }
        return prompt;
    }

    /**
     * Invoke the AI service with the formatted prompt
     */
    async invokeLLM(prompt) {
        if (!this.dispatcher) {
            throw new Error('Inference dispatcher not available');
        }

        // Use dispatcher with mode 'port-listener' (no tools, no rules)
        const response = await this.dispatcher.dispatch(prompt, [], { mode: 'port-listener' });
        return response;
    }

    /**
     * Unregister a port listener
     */
    async unregister(port) {
        const listener = this.listeners.get(port);
        if (!listener) {
            throw new Error(`No listener on port ${port}`);
        }

        return new Promise((resolve) => {
            listener.server.close(() => {
                console.log(`[PortListener] Stopped listener on port ${port}`);
                this.listeners.delete(port);
                this.emit('listener-stopped', { port, name: listener.config.name });
                resolve({ success: true, port });
            });
        });
    }

    /**
     * Get list of active listeners
     */
    getListeners() {
        return Array.from(this.listeners.entries()).map(([port, { config }]) => ({
            port,
            name: config.name,
            method: config.method || 'POST',
            promptTemplate: config.promptTemplate
        }));
    }

    /**
     * Stop all listeners
     */
    async stopAll() {
        const ports = Array.from(this.listeners.keys());
        for (const port of ports) {
            await this.unregister(port);
        }
    }
}

module.exports = PortListenerManager;
