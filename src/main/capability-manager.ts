// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * CapabilityManager - Manages tool permissions and capability groups
 * 
 * Architecture:
 * - Main Switch: Master toggle for all tools
 * - Safe Tools: Always available when main switch ON
 * - 6 Groups: Toggleable capability groups
 */
class CapabilityManager extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        this.config = null;
        this.customToolSafety = new Map(); // toolName -> isSafe
        this.loadConfig();
    }

    get settingsKey() {
        return 'tool.classification.state';
    }

    loadConfig() {
        const configPath = path.join(__dirname, 'tool-classification.json');
        const rawConfig = fs.readFileSync(configPath, 'utf-8');
        this.config = JSON.parse(rawConfig);
        this.applyStoredState();
    }

    applyStoredState() {
        const rawState = this.db?.getSettingSync?.(this.settingsKey);
        if (!rawState) return;

        let state;
        try {
            state = JSON.parse(rawState);
        } catch (error) {
            console.warn('[CapabilityManager] Ignoring invalid stored capability state:', error.message);
            return;
        }

        if (typeof state?.mainEnabled === 'boolean') {
            this.config.mainSwitch.enabled = state.mainEnabled;
        }

        const groups = state?.groups;
        if (!groups || typeof groups !== 'object') return;

        for (const [groupId, value] of Object.entries(groups)) {
            const group = this.config.groups[groupId];
            if (!group) continue;

            if (groupId === 'files') {
                if (['off', 'read', 'full'].includes(value)) {
                    group.mode = value;
                }
                continue;
            }

            if (groupId === 'terminal') {
                if (['off', 'workspace', 'system'].includes(value)) {
                    group.mode = value;
                    delete group.enabled;
                }
                continue;
            }

            if (typeof value === 'boolean') {
                group.enabled = value;
            }
        }
    }

    saveConfig() {
        if (this.db?.setSetting) {
            void this.db.setSetting(this.settingsKey, JSON.stringify(this.getState()));
        }
        this.emit('config-changed', this.config);
    }

    // ==================== Main Switch ====================

    isMainEnabled() {
        return this.config.mainSwitch.enabled;
    }

    setMainEnabled(enabled) {
        this.config.mainSwitch.enabled = enabled;
        this.saveConfig();
        return this.config.mainSwitch.enabled;
    }

    // ==================== Group Management ====================

    isGroupEnabled(groupId) {
        const group = this.config.groups[groupId];
        if (!group) return false;

        // Files and terminal groups use modes instead of enabled booleans.
        if (groupId === 'files' || groupId === 'terminal') {
            return group.mode !== 'off';
        }
        return group.enabled === true;
    }

    setGroupEnabled(groupId, enabled) {
        const group = this.config.groups[groupId];
        if (!group) return false;

        // If enabling any group, auto-enable main switch
        if (enabled && !this.config.mainSwitch.enabled) {
            this.config.mainSwitch.enabled = true;
        }

        if (groupId === 'files') {
            group.mode = enabled ? 'read' : 'off';
        } else if (groupId === 'terminal') {
            group.mode = enabled ? 'workspace' : 'off';
            delete group.enabled;
        } else {
            group.enabled = enabled;
        }

        this.saveConfig();
        return true;
    }

    getFilesMode() {
        return this.config.groups.files.mode;
    }

    setFilesMode(mode) {
        if (!['off', 'read', 'full'].includes(mode)) {
            throw new Error('Invalid files mode. Use: off, read, full');
        }

        // If enabling files, auto-enable main switch
        if (mode !== 'off' && !this.config.mainSwitch.enabled) {
            this.config.mainSwitch.enabled = true;
        }

        this.config.groups.files.mode = mode;
        this.saveConfig();
        return mode;
    }

    getTerminalMode() {
        const group = this.config.groups.terminal || {};
        if (typeof group.mode === 'string') {
            return ['off', 'workspace', 'system'].includes(group.mode) ? group.mode : 'workspace';
        }
        return group.enabled === false ? 'off' : 'workspace';
    }

    setTerminalMode(mode) {
        if (!['off', 'workspace', 'system'].includes(mode)) {
            throw new Error('Invalid terminal mode. Use: off, workspace, system');
        }

        if (mode !== 'off' && !this.config.mainSwitch.enabled) {
            this.config.mainSwitch.enabled = true;
        }

        if (!this.config.groups.terminal) {
            this.config.groups.terminal = {
                name: 'Terminal',
                description: 'Execute shell commands',
                icon: '💻',
                tools: ['run_command']
            };
        }
        this.config.groups.terminal.mode = mode;
        delete this.config.groups.terminal.enabled;
        this.saveConfig();
        return mode;
    }

    // ==================== Tool Access ====================

    getActiveTools() {
        // If main switch is off, no tools available
        if (!this.config.mainSwitch.enabled) {
            return [];
        }

        const activeTools = new Set();

        // Always include safe tools when main is on
        this.config.safeTools.tools.forEach(tool => activeTools.add(tool));

        // Add tools from enabled groups
        for (const [groupId, group] of Object.entries(this.config.groups)) {
            if (groupId === 'files') {
                // Files group uses mode
                const modeTools = group.modes[group.mode] || [];
                modeTools.forEach(tool => activeTools.add(tool));
            } else if (groupId === 'terminal') {
                const mode = this.getTerminalMode();
                const modeTools = group.modes?.[mode] || (mode === 'off' ? [] : group.tools || []);
                modeTools.forEach(tool => activeTools.add(tool));
            } else if (group.enabled && group.tools) {
                group.tools.forEach(tool => activeTools.add(tool));
            }
        }

        // Add safe custom tools
        for (const [toolName, isSafe] of this.customToolSafety) {
            if (isSafe || this.config.groups.unsafe.enabled) {
                activeTools.add(toolName);
            }
        }

        return Array.from(activeTools);
    }

    isToolActive(toolName) {
        return this.getActiveTools().includes(toolName);
    }

    // ==================== Custom Tools ====================

    registerCustomTool(toolName, isSafe = false) {
        this.customToolSafety.set(toolName, isSafe);
    }

    unregisterCustomTool(toolName) {
        const removed = this.customToolSafety.delete(toolName);
        if (removed) {
            this.emit('custom-tool-removed', { toolName });
        }
        return removed;
    }

    setCustomToolSafe(toolName, isSafe) {
        this.customToolSafety.set(toolName, isSafe);
        this.emit('custom-tool-safety-changed', { toolName, isSafe });
    }

    isCustomToolSafe(toolName) {
        return this.customToolSafety.get(toolName) === true;
    }

    // ==================== Port Listeners ====================

    getPortListeners() {
        return this.config.groups.ports.listeners || [];
    }

    addPortListener(listener) {
        if (!this.config.groups.ports.listeners) {
            this.config.groups.ports.listeners = [];
        }
        this.config.groups.ports.listeners.push(listener);
        this.saveConfig();
        this.emit('port-listener-added', listener);
        return listener;
    }

    removePortListener(port) {
        const listeners = this.config.groups.ports.listeners || [];
        this.config.groups.ports.listeners = listeners.filter(l => l.port !== port);
        this.saveConfig();
        this.emit('port-listener-removed', port);
    }

    // ==================== State Export ====================

    getState() {
        // Build groups dynamically from config — no hard-coding
        const groups = {};
        for (const [id, group] of Object.entries(this.config.groups)) {
            if (id === 'files') {
                groups[id] = group.mode; // string: 'off'|'read'|'full'
            } else if (id === 'terminal') {
                groups[id] = this.getTerminalMode();
            } else {
                groups[id] = group.enabled === true;
            }
        }
        return {
            mainEnabled: this.config.mainSwitch.enabled,
            groups,
            activeToolCount: this.getActiveTools().length,
            portListeners: this.getPortListeners()
        };
    }

    // Returns the group id that owns a given tool name, or null
    getGroupForTool(toolName) {
        for (const [id, group] of Object.entries(this.config.groups)) {
            if (id === 'files' || id === 'terminal') {
                const allTools = new Set([
                    ...Object.values(group.modes || {}).flat(),
                    ...(group.tools || [])
                ]);
                if (allTools.has(toolName)) return id;
            } else if (Array.isArray(group.tools) && group.tools.includes(toolName)) {
                return id;
            }
        }
        return null;
    }

    getGroupsConfig() {
        return Object.entries(this.config.groups).map(([id, group]) => {
            const isModeGroup = id === 'files' || id === 'terminal';
            const mode = id === 'terminal' ? this.getTerminalMode() : group.mode;
            const tools = isModeGroup ? (group.modes?.[mode] || []) : (group.tools || []);
            return {
                id,
                name: group.name,
                description: group.description,
                icon: group.icon,
                enabled: isModeGroup ? mode !== 'off' : group.enabled === true,
                mode: isModeGroup ? mode : undefined,
                modes: isModeGroup ? group.modes : undefined,
                tools,
                allTools: isModeGroup
                    ? Object.values(group.modes || {}).flat()
                    : (group.tools || []),
                listeners: group.listeners
            };
        });
    }
}

module.exports = CapabilityManager;
