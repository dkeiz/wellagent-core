// @ts-nocheck

class ArtifactMetadataStore {
  constructor(db = null) {
    this.db = db;
    this.available = false;
    if (!this.db?.run) return;
    try {
      this.db.run(`CREATE TABLE IF NOT EXISTS session_artifact_state (
        session_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      )`);
      this.available = true;
    } catch (error) {
      console.error('Artifact metadata persistence unavailable:', error?.message || error);
    }
  }

  loadSessionState(sessionId) {
    if (!this.available || !this.db?.get) return null;
    const row = this.db.get(
      'SELECT state_json FROM session_artifact_state WHERE CAST(session_id AS TEXT) = CAST(? AS TEXT)',
      [String(sessionId)]
    );
    return row?.state_json || null;
  }

  saveSessionState(sessionId, stateJson) {
    if (!this.available || !this.db?.run) return false;
    this.db.run(
      `INSERT INTO session_artifact_state (session_id, state_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = CURRENT_TIMESTAMP`,
      [String(sessionId), String(stateJson)]
    );
    return true;
  }
}

module.exports = ArtifactMetadataStore;
