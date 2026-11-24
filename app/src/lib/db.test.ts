import { describe, it, expect } from 'vitest';
import type Database from '@tauri-apps/plugin-sql';
import { MIGRATIONS, runMigrations, SESSION_CHILD_TABLES } from './db';

// A stub that behaves like tauri-plugin-sql's Database for the two calls
// runMigrations makes: `PRAGMA user_version` (select) and execute(). It tracks
// user_version so we can prove the version only advances after a full apply and
// that a re-run is a no-op (CR:H1). Typed as Database (via Pick) so no `any` casts.
class MigrationDb {
    userVersion = 0;
    executed: string[] = [];

    select = async <T = unknown>(sql: string): Promise<T> => {
        if (sql.includes('PRAGMA user_version')) {
            return [{ user_version: this.userVersion }] as T;
        }
        return [] as T;
    };

    execute = async (sql: string) => {
        this.executed.push(sql);
        const m = sql.match(/PRAGMA user_version = (\d+)/);
        if (m) this.userVersion = Number(m[1]);
        return { rowsAffected: 0, lastInsertId: 0 };
    };

    /** Narrow to the shape runMigrations consumes. */
    asDb(): Database {
        return this as unknown as Database;
    }
}

/**
 * Latest schema version — every migration entry applied.
 *
 * Derived rather than written out: migrations are append-only, so the count *is*
 * the version, and a literal here only ever means these tests need editing every
 * time one is added. The contract under test is that `runMigrations` advances to
 * the end of the list, not that the list is any particular length.
 */
const LATEST_VERSION = MIGRATIONS.length;

describe('runMigrations (CR:H1)', () => {
    it('applies every version from 0 and advances to the latest', async () => {
        const db = new MigrationDb();
        await runMigrations(db.asDb());
        expect(db.userVersion).toBe(LATEST_VERSION);
        // Every v1 statement plus the version bump ran.
        expect(db.executed.some(s => s.includes('CREATE TABLE IF NOT EXISTS sessions'))).toBe(true);
        expect(db.executed.some(s => s.includes('CREATE TABLE IF NOT EXISTS document_pages'))).toBe(true);
        expect(db.executed.at(-1)).toContain(`PRAGMA user_version = ${LATEST_VERSION}`);
    });

    it('is a no-op when already at the latest version (re-run)', async () => {
        const db = new MigrationDb();
        db.userVersion = LATEST_VERSION;
        await runMigrations(db.asDb());
        expect(db.executed).toEqual([]);
    });

    it('re-heals a partially-applied version because the DDL is idempotent', async () => {
        // Simulate a crash before user_version advanced: still 0, but tables may
        // already exist. Re-running must not throw and must reach the latest version.
        const db = new MigrationDb();
        db.userVersion = 0;
        await runMigrations(db.asDb());
        await runMigrations(db.asDb()); // second pass = the heal
        expect(db.userVersion).toBe(LATEST_VERSION);
    });

    it('applies only the missing versions when partway up', async () => {
        const db = new MigrationDb();
        db.userVersion = 1;
        await runMigrations(db.asDb());
        expect(db.userVersion).toBe(LATEST_VERSION);
        // v1's tables are not re-issued; only the later versions' statements run.
        expect(db.executed.some(s => s.includes('CREATE TABLE IF NOT EXISTS sessions'))).toBe(false);
        expect(db.executed.some(s => s.includes('document_page_sets'))).toBe(true);
        expect(db.executed.some(s => s.includes('page_extraction_meta'))).toBe(true);
    });

    it('every migration statement is idempotent — no bare ALTER/CREATE', () => {
        // The loop re-runs a partially-applied version, so a statement that throws
        // on a second pass wedges every later launch. SQLite has no
        // `ADD COLUMN IF NOT EXISTS`, which is why v2 is a side table.
        const all = MIGRATIONS.flat().join('\n');
        expect(all).not.toMatch(/ALTER TABLE/i);
        expect(all).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/i);
    });

    it('orders child tables so deletes leave no dangling rows', () => {
        // Every one of these references sessions and must be deleted before the
        // parent. The constant is the single source of that order, and a new child
        // table missing from it leaks its rows on delete — which is why this asserts
        // the whole list rather than just membership.
        expect(SESSION_CHILD_TABLES).toEqual([
            'csv_outputs',
            'document_page_sets',
            'document_pages',
            'page_extraction_meta',
            'files',
        ]);
    });
});
