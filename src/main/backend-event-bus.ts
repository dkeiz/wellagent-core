// @ts-nocheck
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { buildRuntimePaths } = require('./runtime-paths');

/**
 * BackendEventBus — Central event relay for the autonomous agent architecture.
 *
 * Three responsibilities:
 *   1. Route typed events between backend subsystems (Memory Daemon, Workflow Scheduler, Chat)
 *   2. Bridge events to the renderer via the current window manager
 *   3. For events that need inference, dispatch to the LLM with a behavior prompt —
 *      the LLM decides whether the user should be notified.
 *
 * Events are fire-and-forget from the emitter's perspective.
 * The bus handles routing, inference, and renderer notification asynchronously.
 */
class BackendEventBus extends EventEmitter {
    constructor(options = {}) {
        super();
        this.windowManager = null;
        this.dispatcher = null;
        this.db = null;
        this._notifyPromptCache = null;

        // Log of recent events (ring buffer)
        this._eventLog = [];
        this._maxLogSize = 200;

        // Behavior prompt path
        this._notifyPromptPath = options.notifyPromptPath || buildRuntimePaths(options).backgroundNotifyPromptPath;

        Object.defineProperty(this, 'mainWindow', {
            configurable: true,
            enumerable: false,
            get: () => this.windowManager?.getMainWindow?.() || null
        });
    }

    /**
     * Late-bind dependencies (called from main.js after all services are created)
     */
    init({ windowManager = null, mainWindow = null, dispatcher, db }) {
        this.windowManager = windowManager || {
            getMainWindow: () => mainWindow || null,
            send(channel, payload) {
                if (!mainWindow?.webContents?.send) return false;
                try {
                    mainWindow.webContents.send(channel, payload);
                    return true;
                } catch (error) {
                    return false;
                }
            }
        };
        this.dispatcher = dispatcher;
        this.db = db;
        console.log('[EventBus] Initialized');
    }

    sendToRenderer(channel, payload) {
        return this.windowManager?.send?.(channel, payload) === true;
    }

    // ==================== Event Catalog ====================

    /**
     * Typed event definitions with metadata about routing behavior.
     */
    static EVENTS = {
        // Memory Daemon events
        'memory:saved':           { category: 'memory',   needsInference: false, uiRelay: true  },
        'memory:persona-updated': { category: 'memory',   needsInference: true,  uiRelay: true  },
        'memory:consolidated':    { category: 'memory',   needsInference: false, uiRelay: true  },
        'memory:health-checked':  { category: 'memory',   needsInference: false, uiRelay: false },

        // Daemon lifecycle events
        'daemon:started':         { category: 'daemon',   needsInference: false, uiRelay: true  },
        'daemon:stopped':         { category: 'daemon',   needsInference: false, uiRelay: true  },
        'daemon:tick':            { category: 'daemon',   needsInference: false, uiRelay: false },
        'daemon:idle':            { category: 'daemon',   needsInference: false, uiRelay: false },
        'daemon:error':           { category: 'daemon',   needsInference: false, uiRelay: true  },
        'daemon:task-completed':  { category: 'daemon',   needsInference: true,  uiRelay: true  },

        // Workflow Scheduler events
        'workflow:run-started':       { category: 'workflow', needsInference: false, uiRelay: true  },
        'workflow:run-completed':     { category: 'workflow', needsInference: false, uiRelay: true  },
        'workflow:run-failed':        { category: 'workflow', needsInference: false, uiRelay: true  },
        'workflow:scheduled-complete': { category: 'workflow', needsInference: true,  uiRelay: true  },
        'workflow:scheduled-failed':   { category: 'workflow', needsInference: true,  uiRelay: true  },
        'workflow:scheduled-skipped':  { category: 'workflow', needsInference: false, uiRelay: false },

        // Chat pipeline events (emitted by ipc-handlers / agent-loop)
        'chat:user-active':       { category: 'chat',     needsInference: false, uiRelay: false },
        'chat:user-idle':         { category: 'chat',     needsInference: false, uiRelay: false },
        'chat:session-opened':    { category: 'chat',     needsInference: false, uiRelay: false },
        'chat:session-closed':    { category: 'chat',     needsInference: false, uiRelay: false },

        // Init events
        'init:cold-start':        { category: 'init',     needsInference: false, uiRelay: true  },
        'init:baseinit-complete': { category: 'init',     needsInference: false, uiRelay: true  },

        // Connector events (forwarded from existing ConnectorRuntime)
        'connector:started':      { category: 'connector', needsInference: false, uiRelay: true  },
        'connector:stopped':      { category: 'connector', needsInference: false, uiRelay: true  },
        'connector:error':        { category: 'connector', needsInference: true,  uiRelay: true  },

        // Delegated sub-agent events
        'subagent:queued':        { category: 'agent', needsInference: false, uiRelay: true  },
        'subagent:started':       { category: 'agent', needsInference: false, uiRelay: true  },
        'subagent:completed':     { category: 'agent', needsInference: false, uiRelay: true  },
        'subagent:failed':        { category: 'agent', needsInference: false, uiRelay: true  },
    };

    // ==================== Core API ====================

    /**
     * Publish a typed event.
     *
     * @param {string} eventType — must be a key in EVENTS catalog
     * @param {Object} payload  — event-specific data
     */
    publish(eventType, payload = {}) {
        const eventDef = BackendEventBus.EVENTS[eventType];
        if (!eventDef) {
            console.warn(`[EventBus] Unknown event type: ${eventType}`);
            // Still emit for custom listeners, but skip routing
            this.emit(eventType, payload);
            return;
        }

        const event = {
            type: eventType,
            category: eventDef.category,
            payload,
            timestamp: new Date().toISOString(),
        };

        // Log
        this._log(event);

        // Emit locally (for other backend subscribers like daemons)
        this.emit(eventType, payload);
        this.emit(`category:${eventDef.category}`, event);

        // Relay to renderer UI
        if (eventDef.uiRelay) {
            this.sendToRenderer('background-event', event);
        }

        // Inference dispatch (async, non-blocking)
        if (eventDef.needsInference && this.dispatcher) {
            this._dispatchInference(event).catch(err => {
                console.error(`[EventBus] Inference dispatch failed for ${eventType}:`, err.message);
            });
        }
    }

    // ==================== Inference Dispatch ====================

    /**
     * Send event to LLM with behavior prompt. LLM decides whether to notify user.
     */
    async _dispatchInference(event) {
        const prompt = this._buildNotifyPrompt(event);
        if (!prompt) return;

        try {
            const response = await this.dispatcher.dispatch(prompt, [], {
                mode: 'internal',
                includeTools: false,
                includeRules: false,
                preemptible: true,
            });

            if (response && response.stopped) {
                console.log(`[EventBus] Inference preempted for ${event.type}`);
                return;
            }

            if (response && response.content) {
                const content = response.content.trim();

                // LLM signals "not notable" by returning empty, "[silent]", or similar
                const silentSignals = ['[silent]', '[skip]', '[no action]', ''];
                const isSilent = silentSignals.some(s =>
                    content.toLowerCase() === s || content.length < 5
                );

                if (!isSilent) {
                    // Send as a background notification message to renderer
                    this.sendToRenderer('background-notification', {
                        type: event.type,
                        category: event.category,
                        message: content,
                        timestamp: event.timestamp,
                    });
                    console.log(`[EventBus] LLM decided to notify user for ${event.type}`);
                } else {
                    console.log(`[EventBus] LLM decided to stay silent for ${event.type}`);
                }
            }
        } catch (err) {
            console.error(`[EventBus] Inference failed for ${event.type}:`, err.message);
        }
    }

    /**
     * Build the notification decision prompt from template + event data.
     */
    _buildNotifyPrompt(event) {
        const template = this._loadNotifyTemplate();
        const eventSummary = JSON.stringify({
            type: event.type,
            category: event.category,
            payload: event.payload,
            timestamp: event.timestamp,
        }, null, 2);

        return template.replace('{event_data}', eventSummary);
    }

    _loadNotifyTemplate() {
        if (this._notifyPromptCache) return this._notifyPromptCache;

        try {
            if (fs.existsSync(this._notifyPromptPath)) {
                this._notifyPromptCache = fs.readFileSync(this._notifyPromptPath, 'utf-8');
                return this._notifyPromptCache;
            }
        } catch (e) { /* ignore */ }

        // Fallback template
        this._notifyPromptCache = `You are a background notification agent. A background event just completed.

Review the event data below and decide: should the user be notified?

Rules:
- If the event is routine (memory saved, health check passed) → respond with [silent]
- If the event has notable results the user would want to know about → write a brief, friendly notification (1-2 sentences max)
- If the event indicates an error or something that needs attention → write a clear alert message
- Never be verbose. Be concise and natural.

Event data:
{event_data}

Your response (either [silent] or a brief notification message):`;

        return this._notifyPromptCache;
    }

    // ==================== Event Log ====================

    _log(event) {
        this._eventLog.push(event);
        if (this._eventLog.length > this._maxLogSize) {
            this._eventLog.shift();
        }
        console.log(`[EventBus] ${event.type}`, event.payload?.summary || '');
    }

    /**
     * Get recent events, optionally filtered by category.
     */
    getLog(category = null, limit = 50) {
        let events = this._eventLog;
        if (category) {
            events = events.filter(e => e.category === category);
        }
        return events.slice(-limit);
    }

    /**
     * Clear the event log.
     */
    clearLog() {
        this._eventLog = [];
    }

    /**
     * Invalidate cached notify prompt (e.g., if user edits the template file).
     */
    reloadNotifyPrompt() {
        this._notifyPromptCache = null;
    }
}

module.exports = BackendEventBus;
