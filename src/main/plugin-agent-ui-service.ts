// @ts-nocheck
const { getManifestCapabilityContract } = require('./plugin-capability-contracts');

class PluginAgentUiService {
    constructor(manager) {
        this.manager = manager;
    }

    get plugins() {
        return this.manager.plugins;
    }

    getAgentPlugin(agentSlug) {
        return this.getAgentPlugins(agentSlug)[0] || null;
    }

    parseAgentConfig(agentInfo) {
        const raw = agentInfo?.config;
        if (!raw) return {};
        if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
        if (typeof raw !== 'string') return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    normalizeUiMode(value) {
        const mode = String(value || 'plugin').trim().toLowerCase();
        return ['no_ui', 'noplugin', 'classic'].includes(mode) ? 'no_ui' : 'plugin';
    }

    getConfiguredUiPluginId(agentInfo) {
        const config = this.parseAgentConfig(agentInfo);
        return String(
            config.chat_ui_plugin
            || config.chatUiPlugin
            || config.ui_plugin_id
            || config.uiPluginId
            || ''
        ).trim() || null;
    }

    resolveFallbackUiPluginId(agentInfo) {
        const slug = String(agentInfo?.slug || '').trim();
        if (!slug) return null;

        const legacyContractMap = {
            'file-manager': 'agent-file-browser',
            'research-orchestrator': 'agent-research-orchestrator-ui',
            'universal-rag-agent': 'agent-rag-studio'
        };
        const mappedPlugin = legacyContractMap[slug];
        if (mappedPlugin && this.plugins.has(mappedPlugin)) return mappedPlugin;

        const exactMatches = [];
        for (const [id, plugin] of this.plugins) {
            const declared = String(plugin.manifest?.agentSlug || '').trim();
            if (declared && declared === slug) exactMatches.push(id);
        }
        exactMatches.sort((a, b) => a.localeCompare(b));
        return exactMatches[0] || null;
    }

    resolvePrimaryAgentChatUIPlugin(agentInfo, options = {}) {
        const allowFallback = options.allowFallback !== false;
        const configured = this.getConfiguredUiPluginId(agentInfo);
        if (configured && this.plugins.has(configured)) return configured;
        return allowFallback ? this.resolveFallbackUiPluginId(agentInfo) : null;
    }

    resolveAgentChatUITarget(agentInfo, uiContext = {}) {
        const uiMode = this.normalizeUiMode(uiContext?.uiMode);
        if (uiMode !== 'plugin') return { uiMode, pluginId: null, plugin: null };

        const requestedPluginId = String(uiContext?.uiPluginId || '').trim() || null;
        const primaryPluginId = this.resolvePrimaryAgentChatUIPlugin(agentInfo, { allowFallback: true });
        const resolvedPluginId = requestedPluginId || primaryPluginId;
        if (!resolvedPluginId) return { uiMode, pluginId: null, plugin: null };

        if (primaryPluginId && resolvedPluginId !== primaryPluginId) {
            return { uiMode, pluginId: primaryPluginId, plugin: null, rejectedPluginId: resolvedPluginId };
        }

        const plugin = this.plugins.get(resolvedPluginId) || null;
        if (!plugin || plugin.status !== 'enabled' || !plugin.chatUIs?.length) {
            return { uiMode, pluginId: resolvedPluginId, plugin: null };
        }
        return { uiMode, pluginId: resolvedPluginId, plugin };
    }

    getPluginsByCapability(capability, options = {}) {
        const requested = String(capability || '').trim();
        if (!requested) return [];
        const matches = [];
        for (const [id, plugin] of this.plugins) {
            const capabilities = Array.isArray(plugin.manifest?.capabilities)
                ? plugin.manifest.capabilities.map(value => String(value).trim())
                : [];
            if (!capabilities.includes(requested)) continue;
            if (options.enabledOnly === true && plugin.status !== 'enabled') continue;
            matches.push({
                id,
                name: plugin.manifest.name,
                description: plugin.manifest.description || '',
                status: plugin.status,
                capabilities,
                contract: getManifestCapabilityContract(plugin.manifest, requested)
            });
        }
        return matches;
    }

    getAgentPlugins(agentSlug) {
        const slug = String(agentSlug || '').trim();
        if (!slug) return [];
        const matches = [];
        for (const [id, plugin] of this.plugins) {
            const manifest = plugin.manifest || {};
            const slugs = [
                manifest.agentSlug,
                ...(Array.isArray(manifest.agentSlugs) ? manifest.agentSlugs : [])
            ].filter(Boolean).map(value => String(value).trim());
            if (slugs.includes(slug) || slugs.includes('*')) matches.push(id);
        }
        return matches;
    }

    async getAgentChatUI(agentInfo, uiContext = {}) {
        const target = this.resolveAgentChatUITarget(agentInfo, uiContext);
        if (!target.plugin) return null;

        const panels = [];
        const css = [];
        const actions = {};
        for (const contribution of target.plugin.chatUIs) {
            try {
                const html = typeof contribution.renderPanel === 'function'
                    ? await contribution.renderPanel(agentInfo)
                    : contribution.html;
                if (!html) continue;
                panels.push(`<div class="agent-ui-plugin" data-agent-ui-plugin-id="${target.pluginId}">${html}</div>`);
                if (contribution.css) css.push(`/* ${target.pluginId} */\n${contribution.css}`);
                actions[target.pluginId] = Object.keys(contribution.actions || {});
            } catch (error) {
                console.error(`[PluginManager] Chat UI render failed for "${target.pluginId}":`, error.message);
            }
        }

        if (!panels.length) return null;
        return {
            pluginIds: [target.pluginId],
            uiPluginId: target.pluginId,
            uiMode: target.uiMode,
            title: agentInfo?.name || 'Agent',
            html: panels.join('\n'),
            css: css.join('\n\n'),
            actions
        };
    }

    getEnabledChatContributions(agentInfo, pluginId = null, uiContext = {}) {
        const contextWithPlugin = { ...uiContext, ...(pluginId ? { uiPluginId: pluginId } : {}) };
        const target = this.resolveAgentChatUITarget(agentInfo, contextWithPlugin);
        if (!target.plugin) return [];
        return target.plugin.chatUIs.map(contribution => ({ pluginId: target.pluginId, plugin: target.plugin, contribution }));
    }

    async runAgentChatUIAction(agentInfo, action, payload = {}, uiContext = {}) {
        const actionName = String(action || '').trim();
        if (!actionName) throw new Error('Agent chat UI action is required');

        const requestedPluginId = payload?.pluginId || payload?._pluginId || null;
        for (const { pluginId, plugin, contribution } of this.getEnabledChatContributions(agentInfo, requestedPluginId, uiContext)) {
            const handler = contribution.actions?.[actionName];
            if (typeof handler !== 'function') continue;
            return this.manager.runWithArtifactJournal({
                agentInfo,
                sessionId: uiContext?.sessionId || payload?.sessionId || null,
                source: `plugin_ui:${pluginId}:${actionName}`
            }, () => handler({
                    agentInfo,
                    payload,
                    pluginId,
                    uiContext,
                    context: plugin.context,
                    render: () => (typeof contribution.renderPanel === 'function'
                        ? contribution.renderPanel(agentInfo)
                        : contribution.html || '')
                }));
        }
        throw new Error(`Agent chat UI action "${actionName}" not found`);
    }

    async handleAgentChatUIEvent(agentInfo, eventName, payload = {}, uiContext = {}) {
        const key = eventName === 'activated'
            ? 'onTabActivated'
            : eventName === 'deactivated'
                ? 'onTabDeactivated'
                : null;
        if (!key) return null;

        const results = [];
        for (const { pluginId, plugin, contribution } of this.getEnabledChatContributions(agentInfo, null, uiContext)) {
            const handler = contribution[key];
            if (typeof handler === 'function') {
                results.push(await handler(agentInfo, payload, plugin.context, pluginId));
            }
        }
        return { success: true, results };
    }
}

module.exports = PluginAgentUiService;
