// @ts-nocheck
const path = require('path');

const PRIVATE_SESSION_PREFIX = 'private-';

function isPrivateSessionId(sessionId) {
    return String(sessionId || '').startsWith(PRIVATE_SESSION_PREFIX);
}

function createPrivateSessionId() {
    return `${PRIVATE_SESSION_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function artifactKindFromName(fileName) {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (['.txt', '.md', '.json', '.jsonl', '.log', '.csv', '.yaml', '.yml'].includes(ext)) return 'text';
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'image';
    if (['.xlsx', '.xls', '.ods', '.docx', '.doc', '.pdf', '.pptx', '.ppt'].includes(ext)) return 'document';
    return 'file';
}

class PrivateSessionStore {
    constructor(options = {}) {
        this.sessionWorkspace = options.sessionWorkspace || null;
        this.sessions = new Map();
    }

    createSession(options = {}) {
        const id = options.id && isPrivateSessionId(options.id)
            ? String(options.id)
            : createPrivateSessionId();
        const now = new Date().toISOString();
        const session = {
            id,
            title: options.title || 'Private Chat',
            private: true,
            created_at: now,
            last_message_at: now,
            messages: []
        };
        this.sessions.set(id, session);
        return this._summary(session);
    }

    ensureSession(sessionId = null) {
        if (sessionId && this.sessions.has(sessionId)) {
            return this.sessions.get(sessionId);
        }
        if (sessionId && isPrivateSessionId(sessionId)) {
            this.createSession({ id: sessionId });
            return this.sessions.get(sessionId);
        }
        const created = this.createSession();
        return this.sessions.get(created.id);
    }

    addMessage(sessionId, message = {}) {
        const session = this.ensureSession(sessionId);
        const stored = {
            role: message.role || 'user',
            content: String(message.content || ''),
            metadata: message.metadata || null,
            timestamp: new Date().toISOString()
        };
        session.messages.push(stored);
        session.last_message_at = stored.timestamp;
        return stored;
    }

    getMessages(sessionId, limit = 100) {
        const session = this.sessions.get(sessionId);
        if (!session) return [];
        return session.messages.slice(-Math.max(1, Number(limit) || 100));
    }

    clearSession(sessionId) {
        const session = this.ensureSession(sessionId);
        session.messages = [];
        session.last_message_at = new Date().toISOString();
        return { cleared: true, sessionId: session.id };
    }

    deleteSession(sessionId, options = {}) {
        const existed = this.sessions.delete(sessionId);
        const cleanupWorkspace = options.cleanupWorkspace !== false;
        const workspaceDeleted = cleanupWorkspace && this.sessionWorkspace?.cleanup
            ? this.sessionWorkspace.cleanup(sessionId)
            : false;
        return { success: true, existed, sessionId, workspaceDeleted };
    }

    getCloseSummary(sessionId) {
        const session = this.sessions.get(sessionId) || null;
        const files = this.sessionWorkspace?.listFiles
            ? this.sessionWorkspace.listFiles(sessionId)
            : [];
        const normalizedFiles = files.map(file => {
            const kind = artifactKindFromName(file.name);
            return {
                name: file.name,
                size: file.size,
                created: file.created,
                kind,
                saveRecommended: kind !== 'text' || file.size > 1024 * 1024
            };
        });
        return {
            success: true,
            private: true,
            sessionId,
            exists: Boolean(session),
            requiresConfirmation: true,
            messageCount: session ? session.messages.length : 0,
            fileCount: normalizedFiles.length,
            files: normalizedFiles,
            saveRecommended: normalizedFiles.some(file => file.saveRecommended)
        };
    }

    _summary(session) {
        return {
            id: session.id,
            title: session.title,
            private: true,
            created_at: session.created_at,
            last_message_at: session.last_message_at,
            message_count: session.messages.length
        };
    }
}

module.exports = {
    PRIVATE_SESSION_PREFIX,
    PrivateSessionStore,
    isPrivateSessionId
};
