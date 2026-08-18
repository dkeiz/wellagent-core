// ---------------------------------------------------------------------------
// lib/auth/secret-store.ts — Encrypted secret storage
// ---------------------------------------------------------------------------

import * as crypto from 'crypto';
import type { SettingsStore, Logger } from '../core/types';
import { ScopedSettingsAccessor } from '../core/settings';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SECRET_PREFIX = 'enc:v1:';

/**
 * Encrypted secret store — encrypts API keys, tokens, and other
 * sensitive values before persisting to the settings store.
 *
 * Uses AES-256-GCM. The encryption key must be supplied by the host as a
 * passphrase or 32-byte key. In production, the key would come from the
 * OS keychain (e.g. via `keytar`).
 *
 * Usage:
 * ```typescript
 * const secrets = new SecretStore(db, { passphrase: 'my-app-key' });
 * await secrets.set('openai.apiKey', 'sk-abc123...');
 * const key = await secrets.get('openai.apiKey');
 * ```
 */
export class SecretStore extends ScopedSettingsAccessor {
  private _key: Buffer;
  private _logger: Logger;

  constructor(
    db: SettingsStore,
    options: { passphrase?: string; key?: Buffer; logger?: Logger } = {}
  ) {
    super(db);
    if (options.key) {
      if (options.key.length !== KEY_LENGTH) {
        throw new Error('SecretStore key must be exactly 32 bytes');
      }
      this._key = options.key;
    } else {
      const passphrase = String(options.passphrase || '').trim();
      if (!passphrase) {
        throw new Error('SecretStore requires a host-provided passphrase or 32-byte key');
      }
      this._key = crypto.scryptSync(passphrase, 'localagent-salt', KEY_LENGTH);
    }
    this._logger = options.logger ?? console;
  }

  /**
   * Store an encrypted secret.
   */
  async set(key: string, plaintext: string): Promise<void> {
    const encrypted = this.encrypt(plaintext);
    await this._saveSetting(`secret.${key}`, encrypted);
  }

  /**
   * Retrieve and decrypt a secret.
   */
  async get(key: string): Promise<string | null> {
    const stored = await this._getSetting(`secret.${key}`);
    if (!stored) return null;

    if (stored.startsWith(SECRET_PREFIX)) {
      try {
        return this.decrypt(stored);
      } catch (error: any) {
        this._logger.warn?.(`[SecretStore] Decryption failed for ${key}:`, error?.message);
        return null;
      }
    }

    // Legacy plaintext — migrate
    await this.set(key, stored);
    return stored;
  }

  /**
   * Delete a secret.
   */
  async delete(key: string): Promise<void> {
    await this._saveSetting(`secret.${key}`, '');
  }

  /**
   * Check if a value is encrypted.
   */
  isEncrypted(value: string): boolean {
    return value.startsWith(SECRET_PREFIX);
  }

  /**
   * Encrypt a plaintext string.
   */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this._key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return SECRET_PREFIX + combined.toString('base64');
  }

  /**
   * Decrypt an encrypted string.
   */
  decrypt(encrypted: string): string {
    if (!encrypted.startsWith(SECRET_PREFIX)) {
      throw new Error('Not an encrypted value');
    }

    const combined = Buffer.from(encrypted.slice(SECRET_PREFIX.length), 'base64');
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this._key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  }

  /**
   * Redact a secret value for display (show only last 4 chars).
   */
  static redact(value: string): string {
    if (!value || value.length <= 4) return '****';
    return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
  }
}
