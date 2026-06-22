import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared call log so we can assert ordering across the db and fs boundaries.
const log: string[] = [];

const fakeDb = {
    select: vi.fn(async (sql: string) => {
        if (sql.includes('FROM files')) return [{ file_path: '/data/upload.pdf' }];
        if (sql.includes('FROM document_pages')) return [{ image_path: '/data/page1.png' }, { image_path: '' }];
        return [];
    }),
    execute: vi.fn(async (sql: string) => {
        log.push(`db:${sql.replace(/\s+/g, ' ').trim()}`);
        return { rowsAffected: 1, lastInsertId: 0 };
    }),
};

vi.mock('../../lib/db', () => ({
    getDb: async () => fakeDb,
    SESSION_CHILD_TABLES: ['csv_outputs', 'document_pages', 'files'],
}));

const remove = vi.fn(async (p: string) => {
    log.push(`fs:remove:${p}`);
    if (p === '/data/page1.png') throw new Error('ENOENT'); // already gone
});
vi.mock('@tauri-apps/plugin-fs', () => ({ remove: (p: string) => remove(p) }));

const emitSessionChange = vi.fn();
vi.mock('./sessionEvents', () => ({ emitSessionChange: (d: unknown) => emitSessionChange(d) }));

import { deleteSession } from './sessionActions';

beforeEach(() => {
    log.length = 0;
    vi.clearAllMocks();
});

describe('deleteSession (CR:H1)', () => {
    it('deletes children in order then the parent, before touching the filesystem', async () => {
        await deleteSession('sess-1');

        const dbDeletes = log.filter(l => l.startsWith('db:'));
        expect(dbDeletes).toEqual([
            'db:DELETE FROM csv_outputs WHERE session_id = $1',
            'db:DELETE FROM document_pages WHERE session_id = $1',
            'db:DELETE FROM files WHERE session_id = $1',
            'db:DELETE FROM sessions WHERE id = $1',
        ]);

        // Every DB delete happens before any filesystem removal.
        const firstFsIndex = log.findIndex(l => l.startsWith('fs:'));
        const lastDbIndex = log.map(l => l.startsWith('db:')).lastIndexOf(true);
        expect(lastDbIndex).toBeLessThan(firstFsIndex);
    });

    it('emits a session-change event with the deleted id', async () => {
        await deleteSession('sess-1');
        expect(emitSessionChange).toHaveBeenCalledWith({ deletedSessionId: 'sess-1' });
    });

    it('removes collected paths and skips empty ones, tolerating a missing file', async () => {
        await expect(deleteSession('sess-1')).resolves.toBeUndefined();
        // upload + page1 are removed; the empty image_path is filtered out.
        expect(remove).toHaveBeenCalledWith('/data/upload.pdf');
        expect(remove).toHaveBeenCalledWith('/data/page1.png');
        expect(remove).not.toHaveBeenCalledWith('');
        // The ENOENT on page1 was swallowed (allSettled), so deleteSession resolved.
    });
});
