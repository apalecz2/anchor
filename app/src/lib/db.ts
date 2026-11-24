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
export const MIGRATIONS: string[][] = [
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
    // v2: completeness marker for the page cache.
    //
    // `document_pages` rows are written one INSERT at a time — there is no usable
    // transaction here (see the pool note above) — so a crash or force-quit partway
    // through a long PDF left a truncated set that is indistinguishable from a
    // finished one. The session would then show fewer pages than the document has,
    // for good, with no error and nothing to notice. This row is written only after
    // every page row has landed, so its presence is what makes a cache readable.
    //
    // A side table rather than a column on `document_pages`: SQLite has no
    // `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so a column would throw "duplicate
    // column" when this version is re-run after a partial apply — which the loop
    // below does by design.
    [
        `CREATE TABLE IF NOT EXISTS document_page_sets (
            session_id TEXT PRIMARY KEY,
            page_count INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )`,
    ],

    // v3: which pipeline produced a page's table.
    //
    // Extraction is no longer one hardcoded model. A preset decides what grounds the
    // page — Tesseract's per-word boxes, or a model reporting its own regions — and
    // that choice changes what a cell's stored `wordIds` *mean*, and therefore how
    // precisely the UI can highlight a source. Reopening a session has to render it
    // the way it was produced, not the way the current default would produce it.
    //
    // `preset_version` is recorded alongside the id because a preset's behaviour can
    // change under a fixed id; together they say "this is what ran", which is also
    // what makes a cached result recognisable as stale.
    //
    // A side table rather than columns on `csv_outputs`, for the same reason v2 chose
    // one: SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, and a re-run of a
    // partially-applied version would throw "duplicate column".
    [
        `CREATE TABLE IF NOT EXISTS page_extraction_meta (
            session_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            preset_id TEXT NOT NULL,
            preset_version INTEGER NOT NULL,
            grounding TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(session_id, page_index),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )`,
    ],
];

// Child tables of `sessions`, ordered so that deleting them first leaves no
// dangling rows. deleteSession() walks this list explicitly rather than trusting
// ON DELETE CASCADE — see the FK-pragma note on initDb().
export const SESSION_CHILD_TABLES = [
    'csv_outputs',
    'document_page_sets',
    'document_pages',
    'page_extraction_meta',
    'files',
] as const;

export async function runMigrations(db: Database): Promise<void> {
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

/** Error a query gets once the database has been sealed by the app-data wipe. */
export const DB_SEALED_MESSAGE = 'Anchor’s data has been removed; the database is closed.';

// Set by the wipe. `Database.load` does not merely open a file — tauri-plugin-sql
// re-creates the app directory, the database, and (via runMigrations) its schema. So a
// single query landing in the seconds a wipe takes, or in the moment between it and the
// reload/exit, resurrects `workspace.db` with its `-wal`/`-shm` siblings inside a folder
// the user was just told is empty. That is exactly what happened: the sidebar refreshes
// its recent-session list on a session-change event (AppLayout), and it re-created the
// database milliseconds after the deletion. Sealing blocks *every* such caller — event
// listeners, timers, in-flight promises — instead of chasing them one at a time.
let sealed = false;

export function getDb(): Promise<Database> {
    if (sealed) return Promise.reject(new Error(DB_SEALED_MESSAGE));
    if (!dbPromise) dbPromise = initDb();
    return dbPromise;
}

/** Refuse to (re)open the database until the webview reloads. Call before wiping the
 *  app data; a reload — how both wipe paths end — starts a fresh module and clears it. */
export function sealDb(): void {
    sealed = true;
}

/** Undo `sealDb`, for a wipe that failed before deleting anything: the files are still
 *  there, so the app should keep working rather than be left unable to query. */
export function unsealDb(): void {
    sealed = false;
}

/** Close the connection pool and forget it, so the next `getDb()` reconnects.
 *
 *  Needed before the app-data wipe (`appDataActions.ts`): the plugin keeps the pool
 *  open for the life of the process, and Windows refuses to delete a file that is
 *  still open — with the pool live, `workspace.db` would survive a "remove all data".
 *  Safe to call when no pool was ever opened. */
export async function closeDb(): Promise<void> {
    const pending = dbPromise;
    if (!pending) return;
    // Cleared first: a caller that races in during `close()` must open a fresh pool
    // rather than receive the one being torn down.
    dbPromise = null;
    const db = await pending.catch(() => null);
    if (!db) return;
    try {
        await db.close();
    } catch {
        /* already closed / never connected — nothing left to release */
    }
}
