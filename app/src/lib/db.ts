import Database from '@tauri-apps/plugin-sql';

let dbPromise: Promise<Database> | null = null;

async function initDb(): Promise<Database> {
    const db = await Database.load('sqlite:workspace.db');

    await db.execute('PRAGMA foreign_keys = ON;');

    await db.execute(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS outputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS document_pages (
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
        );
    `);

    return db;
}

export function getDb(): Promise<Database> {
    if (!dbPromise) dbPromise = initDb();
    return dbPromise;
}
