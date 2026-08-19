// @ts-nocheck

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const MODEL_CACHE_POLICIES = Object.freeze({
  openrouter: Object.freeze({ ttlMs: 12 * HOUR, failureBaseMs: 30 * MINUTE, failureMaxMs: 6 * HOUR, authBackoffMs: 24 * HOUR, rateLimitBaseMs: HOUR }),
  opencode: Object.freeze({ ttlMs: 15 * MINUTE, failureBaseMs: 2 * MINUTE, failureMaxMs: 30 * MINUTE, authBackoffMs: 30 * MINUTE, rateLimitBaseMs: 5 * MINUTE }),
  ollama: Object.freeze({ ttlMs: 2 * MINUTE, failureBaseMs: MINUTE, failureMaxMs: 15 * MINUTE, authBackoffMs: 5 * MINUTE, rateLimitBaseMs: 2 * MINUTE }),
  lmstudio: Object.freeze({ ttlMs: MINUTE, failureBaseMs: MINUTE, failureMaxMs: 15 * MINUTE, authBackoffMs: 5 * MINUTE, rateLimitBaseMs: 2 * MINUTE }),
  'local-openai': Object.freeze({ ttlMs: 2 * MINUTE, failureBaseMs: MINUTE, failureMaxMs: 15 * MINUTE, authBackoffMs: 5 * MINUTE, rateLimitBaseMs: 2 * MINUTE }),
  byok: Object.freeze({ ttlMs: 30 * MINUTE, failureBaseMs: 5 * MINUTE, failureMaxMs: HOUR, authBackoffMs: 12 * HOUR, rateLimitBaseMs: 15 * MINUTE }),
  'local-codex': Object.freeze({ ttlMs: 6 * HOUR, failureBaseMs: 2 * MINUTE, failureMaxMs: 30 * MINUTE, authBackoffMs: 30 * MINUTE, rateLimitBaseMs: 5 * MINUTE }),
  qwen: Object.freeze({ ttlMs: 6 * HOUR, failureBaseMs: 15 * MINUTE, failureMaxMs: 4 * HOUR, authBackoffMs: 12 * HOUR, rateLimitBaseMs: 30 * MINUTE }),
  openai: Object.freeze({ ttlMs: 6 * HOUR, failureBaseMs: 15 * MINUTE, failureMaxMs: 4 * HOUR, authBackoffMs: 12 * HOUR, rateLimitBaseMs: 30 * MINUTE }),
  groq: Object.freeze({ ttlMs: 6 * HOUR, failureBaseMs: 15 * MINUTE, failureMaxMs: 4 * HOUR, authBackoffMs: 12 * HOUR, rateLimitBaseMs: 30 * MINUTE }),
  deepseek: Object.freeze({ ttlMs: 6 * HOUR, failureBaseMs: 15 * MINUTE, failureMaxMs: 4 * HOUR, authBackoffMs: 12 * HOUR, rateLimitBaseMs: 30 * MINUTE }),
  mistral: Object.freeze({ ttlMs: 6 * HOUR, failureBaseMs: 15 * MINUTE, failureMaxMs: 4 * HOUR, authBackoffMs: 12 * HOUR, rateLimitBaseMs: 30 * MINUTE }),
  anthropic: Object.freeze({ ttlMs: 6 * HOUR, failureBaseMs: 15 * MINUTE, failureMaxMs: 4 * HOUR, authBackoffMs: 12 * HOUR, rateLimitBaseMs: 30 * MINUTE })
});

const DEFAULT_POLICY = Object.freeze({
  ttlMs: 6 * HOUR,
  failureBaseMs: 10 * MINUTE,
  failureMaxMs: 2 * HOUR,
  authBackoffMs: 12 * HOUR,
  rateLimitBaseMs: 30 * MINUTE
});

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getProviderCachePolicy(provider) {
  const providerId = String(provider || '').trim().toLowerCase();
  const policy = MODEL_CACHE_POLICIES[providerId] || DEFAULT_POLICY;
  const overrideName = `LOCALAGENT_MODEL_CACHE_TTL_${providerId.replace(/[^a-z0-9]+/g, '_').toUpperCase()}_MS`;
  const ttlOverride = Number(process.env[overrideName]);
  return Number.isFinite(ttlOverride) && ttlOverride > 0
    ? { ...policy, ttlMs: ttlOverride }
    : policy;
}

function getFailureBackoffMs(provider, error, failureCount = 1) {
  const policy = getProviderCachePolicy(provider);
  const message = String(error || '').toLowerCase();
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/.test(message)) return policy.authBackoffMs;
  if (/\b429\b|rate.?limit/.test(message)) return Math.min(policy.failureMaxMs, policy.rateLimitBaseMs * (2 ** Math.max(0, failureCount - 1)));
  return Math.min(policy.failureMaxMs, policy.failureBaseMs * (2 ** Math.max(0, failureCount - 1)));
}

function shouldRefreshCache(provider, entry = null, options = {}) {
  if (options.force === true) return true;
  const now = Number(options.now || Date.now());
  const nextRetryAt = timestamp(entry?.nextRetryAt);
  if (nextRetryAt > now) return false;
  const updatedAt = timestamp(entry?.updatedAt || entry?.lastSuccessAt);
  if (!updatedAt) return true;
  return now - updatedAt >= getProviderCachePolicy(provider).ttlMs;
}

function successMetadata(entry = null, now = Date.now()) {
  const at = new Date(now).toISOString();
  return {
    ...(entry || {}),
    updatedAt: at,
    lastAttemptAt: at,
    lastSuccessAt: at,
    lastError: null,
    failureCount: 0,
    nextRetryAt: null
  };
}

function failureMetadata(provider, entry = null, error = '', now = Date.now()) {
  const failureCount = Math.max(0, Number(entry?.failureCount) || 0) + 1;
  const backoffMs = getFailureBackoffMs(provider, error, failureCount);
  return {
    ...(entry || {}),
    lastAttemptAt: new Date(now).toISOString(),
    lastError: String(error || 'Model discovery failed'),
    failureCount,
    nextRetryAt: new Date(now + backoffMs).toISOString()
  };
}

module.exports = {
  failureMetadata,
  getProviderCachePolicy,
  MODEL_CACHE_POLICIES,
  shouldRefreshCache,
  successMetadata
};
