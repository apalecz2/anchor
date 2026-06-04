import Database from '@tauri-apps/plugin-sql';

let dbPromise: Promise<Database> | null = null;

// Each entry is one schema version. Index 0 applies version 1, index 1 applies version 2, etc.
// NEVER edit existing entries — always append a new entry for schema changes.
const MIGRATIONS: string[][] = [
    // v1: initial schema
    [
        `CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE files (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE document_pages (
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
        `CREATE TABLE csv_outputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            csv_content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, page_index)
        )`,
    ],
];

async function runMigrations(db: Database): Promise<void> {
    const rows = await db.select<{ user_version: number }[]>('PRAGMA user_version');
    const currentVersion = rows[0].user_version;

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
        await db.execute('BEGIN');
        try {
            for (const sql of MIGRATIONS[i]) {
                await db.execute(sql);
            }
            await db.execute(`PRAGMA user_version = ${i + 1}`);
            await db.execute('COMMIT');
        } catch (err) {
            await db.execute('ROLLBACK');
            throw err;
        }
    }
}

async function initDb(): Promise<Database> {
    const db = await Database.load('sqlite:workspace.db');
    await db.execute('PRAGMA foreign_keys = ON');
    await runMigrations(db);
    return db;
}

export function getDb(): Promise<Database> {
    if (!dbPromise) dbPromise = initDb();
    return dbPromise;
}
