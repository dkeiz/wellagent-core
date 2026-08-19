// @ts-nocheck
const Database = require('better-sqlite3');
const { resolveDbPath } = require('./database-paths');
const { runDatabaseMigrations } = require('./database-migrations');

function migrateDatabase(options = {}) {
    const dbPath = options.dbPath || resolveDbPath(options);
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');

    try {
        return runDatabaseMigrations(db);
    } finally {
        db.close();
    }
}

module.exports = { migrateDatabase };
