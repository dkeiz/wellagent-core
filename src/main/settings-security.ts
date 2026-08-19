// @ts-nocheck
const SECRET_SETTING_REDACTION = 'configured';

const ORDINARY_SETTING_PATTERNS = Object.freeze([
  /^open_chat_tabs$/,
  /^active_chat_tab$/,
  /^current_session_id$/,
  /^private_close_no_confirm$/,
  /^auto_start$/,
  /^minimize_to_tray$/,
  /^ui\./,
  /^theme(?:\.|$)/,
  /^skin\./,
  /^appearance\./,
  /^chat\./,
  /^todo\./,
  /^execution\./,
  /^tool\.[^.]+\.active$/,
  /^tool_timeout_ms$/,
  /^baseinit\./,
  /^companion\.(enabled|host|port|tls\.|androidBrowserHttps|allowedOrigins)/,
  /^llm\.(provider|model|concurrency\.|thinking\.|showThinking|context|reasoning\.)/,
  /^llm\.[^.]+\.(url|baseUrl|model|useOAuth|profile|runtime|context|thinking|enabled)$/,
  /^active_model_/,
  /^provider\./,
  /^audio\.desktop\./,
  /^tts\./,
  /^stt\./,
  /^workflow\./,
  /^session\./,
  /^memory\./,
  /^daemon\./,
  /^task(?:\.|-|$)/,
  /^plugin-ui\./,
  /^a2a\./,
  /^rag\./
]);

function normalizeSettingKey(key) {
  return String(key || '').trim();
}

function isSecretSettingKey(key) {
  const normalized = normalizeSettingKey(key);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, '');
  if (/(apikey|apihash|oauthcreds|oauthcredentials|accesstoken|bearertoken|sessiontoken|refreshtoken|idtoken|bottoken|proxypassword|proxysecret)/.test(compact)) {
    return true;
  }
  const segments = lower.split(/[._:-]+/).filter(Boolean);
  return segments.some(segment => (
    segment === 'password'
    || segment === 'secret'
    || segment === 'credential'
    || segment === 'credentials'
    || segment === 'token'
  ));
}

function isOrdinarySettingKey(key) {
  const normalized = normalizeSettingKey(key);
  if (!normalized || isSecretSettingKey(normalized)) return false;
  return ORDINARY_SETTING_PATTERNS.some(pattern => pattern.test(normalized));
}

function assertGenericSettingAllowed(key) {
  const normalized = normalizeSettingKey(key);
  if (!normalized) {
    throw new Error('Setting key is required');
  }
  if (isSecretSettingKey(normalized)) {
    throw new Error(`Setting "${normalized}" must use a credential-specific IPC path`);
  }
  if (!isOrdinarySettingKey(normalized)) {
    throw new Error(`Setting "${normalized}" is not on the generic settings allowlist`);
  }
  return normalized;
}

async function saveGenericSetting(db, key, value, options = {}) {
  const normalized = assertGenericSettingAllowed(key);
  if (db?.saveScopedSetting && options && typeof options === 'object' && (options.requestContext || options.userId)) {
    return db.saveScopedSetting(normalized, value, options);
  }
  return db.saveSetting(normalized, value);
}

async function getGenericSettingValue(db, key, options = {}) {
  const normalized = normalizeSettingKey(key);
  if (!normalized || isSecretSettingKey(normalized)) {
    return null;
  }
  if (db?.getScopedSetting && options && typeof options === 'object' && (options.requestContext || options.userId)) {
    return db.getScopedSetting(normalized, options);
  }
  return db.getSetting(normalized);
}
function redactSettingsForRenderer(settings = {}) {
  const output = {};
  for (const [key, value] of Object.entries(settings || {})) {
    output[key] = isSecretSettingKey(key) && value ? SECRET_SETTING_REDACTION : value;
  }
  return output;
}

function credentialNameForSetting(key) {
  return `setting.${normalizeSettingKey(key)}`;
}

async function migrateSecretSettingsToCredentials(db) {
  if (!db?.getAllSettings || !db?.setCredential) {
    return { migrated: 0 };
  }
  const settings = await db.getAllSettings();
  let migrated = 0;
  for (const [key, value] of Object.entries(settings || {})) {
    if (!value || !isSecretSettingKey(key)) continue;
    await db.setCredential(credentialNameForSetting(key), String(value));
    if (db.deleteSetting) {
      await db.deleteSetting(key);
    } else if (db.saveSetting) {
      await db.saveSetting(key, '');
    }
    migrated += 1;
  }
  return { migrated };
}

async function migrateRemoteGatewaySecret(db) {
  if (!db?.setCredential || !db?.getCredential) {
    return { migrated: 0 };
  }

  const primary = await db.getCredential('remoteGateway.secret');
  const generic = await db.getCredential('setting.remoteGateway.secret');
  const plaintext = db.getSetting ? await db.getSetting('remoteGateway.secret') : null;
  const value = primary || generic || plaintext;
  let migrated = 0;

  if (value && !primary) {
    await db.setCredential('remoteGateway.secret', String(value));
    migrated += 1;
  }
  if (plaintext && db.deleteSetting) {
    await db.deleteSetting('remoteGateway.secret');
  }
  if (generic && db.deleteCredential) {
    await db.deleteCredential('setting.remoteGateway.secret');
  }

  return { migrated };
}

module.exports = {
  SECRET_SETTING_REDACTION,
  assertGenericSettingAllowed,
  credentialNameForSetting,
  getGenericSettingValue,
  isOrdinarySettingKey,
  isSecretSettingKey,
  migrateRemoteGatewaySecret,
  migrateSecretSettingsToCredentials,
  redactSettingsForRenderer,
  saveGenericSetting
};

