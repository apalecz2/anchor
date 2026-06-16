import Database from '@tauri-apps/plugin-sql';

let dbPromise: Promise<Database> | null = null;

// Each entry is one schema version. Index 0 applies version 1, index 1 applies version 2, etc.
// NEVER edit existing entries — always append a new entry for schema changes.
//
// Every statement must be individually idempotent (CREATE TABLE IF NOT EXISTS,
// CREATE INDEX IF NOT EXISTS, etc.). tauri-plugin-sql runs on an sqlx connection
// pool, so a BEGIN/COMMIT issued as separate execute() calls is NOT guaranteed to
// land on one connection — i.e. the "transaction" can silently not be one. We
// therefore do not wrap migrations in a transaction; instead, re-running a
// partially-applied version is a safe no-op, and user_version only advances once
// every statement in that version has succeeded.
const MIGRATIONS: string[][] = [
    // v1: initial schema
    [
        `CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS document_pages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            image_path TEXT NOT NULL,
            natural_width INTEGER NOT NULL,
            natural_height INTEGER NOT NULL,
            full_text TEXT NOT NULL,
            words_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, page_index)
        )`,
        `CREATE TABLE IF NOT EXISTS csv_outputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            csv_content TEXT NOT NULL,
            cell_mappings_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, page_index)
        )`,
    ],
];

// Child tables of `sessions`, ordered so that deleting them first leaves no
// dangling rows. deleteSession() walks this list explicitly rather than trusting
// ON DELETE CASCADE — see the FK-pragma note on initDb().
export const SESSION_CHILD_TABLES = ['csv_outputs', 'document_pages', 'files'] as const;

async function runMigrations(db: Database): Promise<void> {
    const rows = await db.select<{ user_version: number }[]>('PRAGMA user_version');
    const currentVersion = rows[0].user_version;

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
        // Statements are idempotent, so a crash mid-version is recovered by simply
        // re-running it next launch; user_version advances only after all succeed.
        for (const sql of MIGRATIONS[i]) {
            await db.execute(sql);
        }
        await db.execute(`PRAGMA user_version = ${i + 1}`);
    }
}

async function initDb(): Promise<Database> {
    const db = await Database.load('sqlite:workspace.db');
    // Best-effort only: `PRAGMA foreign_keys` is per-connection, and the plugin's
    // pool may hand later queries a connection that never ran this. Code must NOT
    // rely on ON DELETE CASCADE firing — deleteSession() deletes children itself.
    await db.execute('PRAGMA foreign_keys = ON');
    await runMigrations(db);
    return db;
}

export function getDb(): Promise<Database> {
    if (!dbPromise) dbPromise = initDb();
    return dbPromise;
}
