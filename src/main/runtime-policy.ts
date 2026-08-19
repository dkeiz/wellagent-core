// @ts-nocheck
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === false) return [];
  return [value];
}

function normalizeAction(value) {
  return String(value || '').trim();
}

function actionMatches(pattern, action) {
  const normalizedPattern = normalizeAction(pattern);
  const normalizedAction = normalizeAction(action);
  if (!normalizedPattern || !normalizedAction) return false;
  if (normalizedPattern === '*') return true;
  if (normalizedPattern.endsWith('.*')) {
    return normalizedAction.startsWith(normalizedPattern.slice(0, -1));
  }
  return normalizedPattern === normalizedAction;
}

function matchesAny(patterns, action) {
  return toArray(patterns).some(pattern => actionMatches(pattern, action));
}

function getManifestRuntimePermissions(manifest = {}) {
  const permissions = manifest.runtimePermissions
    || manifest.runtime_permissions
    || manifest.permissions?.runtime
    || null;
  return permissions && typeof permissions === 'object' ? permissions : null;
}

function resolvePluginProfile(manifest = {}) {
  const permissions = getManifestRuntimePermissions(manifest);
  return String(
    manifest.runtimePolicyProfile
    || manifest.runtime_policy_profile
    || permissions?.profile
    || (permissions ? 'plugin-strict' : 'plugin-legacy')
  );
}

function pluginNameAllowed(grant, name) {
  if (grant === true || grant === '*') return true;
  const values = toArray(grant).map(value => String(value || '').trim()).filter(Boolean);
  if (values.includes('*')) return true;
  return values.includes(String(name || '').trim());
}

function decidePluginManifestPolicy(action, manifest = {}, metadata = {}) {
  const permissions = getManifestRuntimePermissions(manifest);
  if (!permissions) return null;

  if (matchesAny(permissions.denyActions || permissions.deny_actions, action)) {
    return {
      allowed: false,
      reason: 'plugin_manifest_denied'
    };
  }

  if (matchesAny(permissions.actions, action)) {
    return {
      allowed: true,
      reason: 'plugin_manifest_action'
    };
  }

  if (action.startsWith('plugin.connector.')) {
    const connectorGrant = permissions.connectors;
    const connectorName = metadata.connectorName || metadata.name || metadata.resource || '';
    return {
      allowed: pluginNameAllowed(connectorGrant, connectorName),
      reason: 'plugin_connector_permission'
    };
  }

  if (action === 'plugin.process.manage') {
    return {
      allowed: permissions.managedProcesses === true || permissions.managed_processes === true || permissions.processes === true,
      reason: 'plugin_process_permission'
    };
  }

  if (action.startsWith('plugin.network.')) {
    return {
      allowed: permissions.network === true || pluginNameAllowed(permissions.network, metadata.host || metadata.resource || '*'),
      reason: 'plugin_network_permission'
    };
  }

  return null;
}

const DEFAULT_PROFILES = Object.freeze({
  'trusted-main': Object.freeze({ actions: ['*'] }),
  'wide-agent': Object.freeze({ actions: ['*'] }),
  'normal-agent': Object.freeze({
    actions: [
      'tool.execute',
      'filesystem.read',
      'filesystem.write',
      'network.provider',
      'network.local',
      'credential.use'
    ]
  }),
  'strict-subagent': Object.freeze({
    actions: [
      'tool.execute',
      'filesystem.read'
    ]
  }),
  'renderer-ipc': Object.freeze({
    actions: ['ipc.invoke']
  }),
  'companion-standard': Object.freeze({
    actions: [
      'companion.route',
      'companion.session',
      'companion.artifact.ticket',
      'tool.execute'
    ]
  }),
  'plugin-legacy': Object.freeze({
    actions: ['plugin.*']
  }),
  'plugin-strict': Object.freeze({
    actions: [
      'plugin.action.run',
      'plugin.chatui.register',
      'plugin.config.read',
      'plugin.config.write',
      'plugin.handler.register',
      'plugin.log'
    ]
  }),
  companion: Object.freeze({
    actions: [
      'companion.route',
      'companion.session',
      'companion.artifact.ticket',
      'tool.execute'
    ]
  })
});

const RUNTIME_PERMISSION_FIELDS = Object.freeze(new Set([
  'profile',
  'actions',
  'denyActions',
  'deny_actions',
  'connectors',
  'managedProcesses',
  'managed_processes',
  'processes',
  'network'
]));

function validatePluginRuntimePermissions(manifest = {}) {
  const permissions = getManifestRuntimePermissions(manifest);
  if (!permissions) return { ok: true, issues: [] };
  const issues = [];
  for (const key of Object.keys(permissions)) {
    if (!RUNTIME_PERMISSION_FIELDS.has(key)) {
      issues.push(`Unsupported runtimePermissions field "${key}"`);
    }
  }
  if (permissions.profile && !['plugin-strict', 'plugin-legacy'].includes(String(permissions.profile))) {
    issues.push(`Unsupported plugin runtimePermissions profile "${permissions.profile}"`);
  }
  for (const key of ['actions', 'denyActions', 'deny_actions', 'connectors', 'network']) {
    const value = permissions[key];
    if (value === undefined || value === null || value === true || value === '*') continue;
    if (!Array.isArray(value)) {
      issues.push(`runtimePermissions.${key} must be an array, true, or "*"`);
    }
  }
  return { ok: issues.length === 0, issues };
}

class RuntimePolicy {
  constructor(options = {}) {
    this.defaultProfile = String(options.defaultProfile || 'trusted-main');
    this.profiles = {
      ...DEFAULT_PROFILES,
      ...(options.profiles || {})
    };
  }

  createPluginPrincipal(pluginId, manifest = {}) {
    return {
      type: 'plugin',
      id: `plugin:${String(pluginId || manifest.id || '').trim()}`,
      profile: resolvePluginProfile(manifest)
    };
  }

  createRendererIpcPrincipal(channel = '') {
    return {
      type: 'renderer',
      id: `renderer:ipc:${String(channel || '*').trim() || '*'}`,
      profile: 'renderer-ipc'
    };
  }

  createCompanionPrincipal(device = {}) {
    const deviceId = typeof device === 'string' ? device : device?.deviceId;
    return {
      type: 'companion',
      id: `companion:${String(deviceId || 'unknown').trim() || 'unknown'}`,
      profile: 'companion-standard'
    };
  }

  resolvePrincipal(input = {}) {
    const rawPrincipal = input.principal || input.context?.principal || null;
    if (typeof rawPrincipal === 'string') {
      return {
        type: rawPrincipal.split(':')[0] || 'unknown',
        id: rawPrincipal,
        profile: input.profile || input.context?.runtimePolicyProfile || this.defaultProfile
      };
    }

    const principal = rawPrincipal && typeof rawPrincipal === 'object' ? { ...rawPrincipal } : {};
    return {
      type: principal.type || input.context?.principalType || 'main',
      id: principal.id || input.context?.principalId || 'main',
      profile: input.profile
        || principal.profile
        || input.context?.runtimePolicyProfile
        || input.context?.policyProfile
        || this.defaultProfile
    };
  }

  decide(input = {}) {
    const action = normalizeAction(input.action);
    const metadata = input.metadata || input.context || {};
    const principal = this.resolvePrincipal(input);
    const profileName = String(principal.profile || this.defaultProfile);
    const profile = this.profiles[profileName] || this.profiles[this.defaultProfile] || DEFAULT_PROFILES['trusted-main'];

    if (!action) {
      return { allowed: false, reason: 'missing_action', principal, profile: profileName };
    }

    if (matchesAny(input.context?.runtimePolicy?.denyActions, action)) {
      return { allowed: false, reason: 'context_denied', principal, profile: profileName };
    }

    if (principal.type === 'plugin' || action.startsWith('plugin.')) {
      const manifestDecision = decidePluginManifestPolicy(action, input.manifest || {}, metadata);
      if (manifestDecision) {
        return { ...manifestDecision, principal, profile: profileName };
      }
    }

    const grantActions = [
      ...(toArray(input.grants?.actions)),
      ...(toArray(input.context?.runtimePolicy?.actions)),
      ...(toArray(input.context?.runtimePolicyGrants?.actions))
    ];
    if (matchesAny(grantActions, action)) {
      return { allowed: true, reason: 'explicit_grant', principal, profile: profileName };
    }

    const allowed = matchesAny(profile.actions, action);
    return {
      allowed,
      reason: allowed ? 'profile_allowed' : 'profile_denied',
      principal,
      profile: profileName
    };
  }

  assert(input = {}) {
    const decision = this.decide(input);
    if (decision.allowed) {
      return true;
    }

    const principalId = decision.principal?.id || 'unknown';
    const action = normalizeAction(input.action);
    const error = new Error(`Runtime policy denied ${action} for ${principalId}`);
    error.code = 'RUNTIME_POLICY_DENIED';
    error.decision = decision;
    throw error;
  }
}

module.exports = {
  DEFAULT_PROFILES,
  RuntimePolicy,
  getManifestRuntimePermissions,
  resolvePluginProfile,
  validatePluginRuntimePermissions
};
