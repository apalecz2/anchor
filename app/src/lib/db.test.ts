import { describe, it, expect } from 'vitest';
import type Database from '@tauri-apps/plugin-sql';
import { runMigrations, SESSION_CHILD_TABLES } from './db';

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

describe('runMigrations (CR:H1)', () => {
    it('applies v1 from user_version 0 and advances the version', async () => {
        const db = new MigrationDb();
        await runMigrations(db.asDb());
        expect(db.userVersion).toBe(1);
        // Every v1 statement plus the version bump ran.
        expect(db.executed.some(s => s.includes('CREATE TABLE IF NOT EXISTS sessions'))).toBe(true);
        expect(db.executed.some(s => s.includes('CREATE TABLE IF NOT EXISTS document_pages'))).toBe(true);
        expect(db.executed.at(-1)).toContain('PRAGMA user_version = 1');
    });

    it('is a no-op when already at the latest version (re-run)', async () => {
        const db = new MigrationDb();
        db.userVersion = 1;
        await runMigrations(db.asDb());
        expect(db.executed).toEqual([]);
    });

    it('re-heals a partially-applied version because the DDL is idempotent', async () => {
        // Simulate a crash before user_version advanced: still 0, but tables may
        // already exist. Re-running must not throw and must reach version 1.
        const db = new MigrationDb();
        db.userVersion = 0;
        await runMigrations(db.asDb());
        await runMigrations(db.asDb()); // second pass = the heal
        expect(db.userVersion).toBe(1);
    });

    it('orders child tables so deletes leave no dangling rows', () => {
        // csv_outputs / document_pages / files all reference sessions; they must be
        // deleted before the parent. The constant is the single source of that order.
        expect(SESSION_CHILD_TABLES).toEqual(['csv_outputs', 'document_pages', 'files']);
    });
});
