// @ts-nocheck
function loadConfig(env = process.env) {
  return {
    host: env.REMOTE_GATEWAY_HOST || '0.0.0.0',
    port: Number(env.PORT || env.REMOTE_GATEWAY_PORT) || 8791,
    secret: String(env.REMOTE_GATEWAY_SECRET || env.GATEWAY_SECRET || '').trim(),
    maxBodyBytes: Number(env.REMOTE_GATEWAY_MAX_BODY_BYTES) || 10 * 1024 * 1024
  };
}

module.exports = { loadConfig };
