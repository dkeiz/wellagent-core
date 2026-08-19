// @ts-nocheck
function normalizeConnectorName(name) {
    const normalized = String(name || '').trim();
    if (!normalized) {
        throw new Error('Connector name is required');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
        throw new Error('Connector name may only contain letters, numbers, underscores, and dashes');
    }
    return normalized;
}

module.exports = { normalizeConnectorName };
