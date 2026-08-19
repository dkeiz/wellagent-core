// @ts-nocheck
function getSafeStorage() {
    try {
        const electron = require('electron');
        return electron.safeStorage || null;
    } catch (_) {
        return null;
    }
}

function canEncrypt() {
    const safeStorage = getSafeStorage();
    try {
        return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch (_) {
        return false;
    }
}

function encryptSecret(value) {
    const secret = String(value || '');
    if (!secret) {
        return { value: '', encrypted: false };
    }

    const safeStorage = getSafeStorage();
    if (!canEncrypt()) {
        return { value: secret, encrypted: false };
    }

    const encrypted = safeStorage.encryptString(secret);
    return {
        value: encrypted.toString('base64'),
        encrypted: true
    };
}

function decryptSecret(value, encrypted) {
    const stored = String(value || '');
    if (!stored || !encrypted) return stored;

    const safeStorage = getSafeStorage();
    if (!canEncrypt()) {
        throw new Error('Secure storage is unavailable on this machine');
    }

    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
}

module.exports = {
    canEncrypt,
    decryptSecret,
    encryptSecret
};
