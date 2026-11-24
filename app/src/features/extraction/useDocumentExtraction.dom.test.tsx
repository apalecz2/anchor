import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { OcrWord } from '../ocr/types';

// ---- Tauri mocks --------------------------------------------------------
const invoke = vi.fn();
const convertFileSrc = vi.fn((p: string) => `asset://${p}`);
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...a: unknown[]) => invoke(...a),
    convertFileSrc: (p: string) => convertFileSrc(p),
}));

// The hook reads the page image itself and hands the viewer a blob URL; `remove`
// is reached through discardCachedPages, which deletes the cached page renders.
const fsRemove = vi.fn(async (_p: string) => {});
vi.mock('@tauri-apps/plugin-fs', () => ({
    readFile: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    remove: (p: string) => fsRemove(p),
}));
// jsdom doesn't implement object URLs; stub them so the blob path is exercisable.
if (!('createObjectURL' in URL)) {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => 'blob:mock';
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
}

// listen captures the registered handler so a test can emit progress events.
let progressHandler: ((e: { payload: unknown }) => void) | null = null;
const unlisten = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => {
        progressHandler = cb;
        return unlisten;
    }),
}));

// ---- Fake DB ------------------------------------------------------------
let cachedPages: Record<string, unknown>[] = [];
// The completeness marker (`document_page_sets`). A cache is only readable when a
// marker exists and its count matches the rows — see the migration note in db.ts.
let pageSets: { page_count: number }[] = [];
let files: { file_path: string }[] = [];
const executed: { sql: string; binds: unknown[] }[] = [];

const fakeDb = {
    select: vi.fn(async (sql: string) => {
        if (sql.includes('document_page_sets')) return pageSets;
        if (sql.includes('FROM document_pages')) return cachedPages;
        if (sql.includes('FROM files')) return files;
        return [];
    }),
    execute: vi.fn(async (sql: string, binds: unknown[] = []) => {
        executed.push({ sql, binds });
        // Honor the deletes the cache-discard path issues, so a read that follows
        // one sees the cache actually gone — otherwise a retry would "reload" the
        // rows it just dropped and never reach process_document.
        if (sql.includes('DELETE FROM document_page_sets')) pageSets = [];
        else if (sql.includes('DELETE FROM document_pages')) cachedPages = [];
        return { rowsAffected: 1, lastInsertId: 0 };
    }),
};
vi.mock('../../lib/db', () => ({
    getDb: async () => fakeDb,
    SESSION_CHILD_TABLES: ['csv_outputs', 'document_page_sets', 'document_pages', 'files'],
}));
vi.mock('../sessions/sessionEvents', () => ({ emitSessionChange: vi.fn() }));

import { useDocumentExtraction } from './useDocumentExtraction';

const word = (id: string, text: string): OcrWord => ({
    id,
    text,
    confidence: 90,
    box_coords: { left: 0, top: 0, width: 10, height: 10 },
});

const cachedPageRow = (words: OcrWord[]) => ({
    image_path: '/p1.png',
    natural_width: 1000,
    natural_height: 1000,
    full_text: 'cached',
    words_json: JSON.stringify(words),
});

beforeEach(() => {
    vi.clearAllMocks();
    cachedPages = [];
    pageSets = [];
    files = [];
    executed.length = 0;
    progressHandler = null;
});

/** Seed a *complete* cache: n page rows and a marker that agrees with them. */
const seedCompleteCache = (rows: Record<string, unknown>[]) => {
    cachedPages = rows;
    pageSets = [{ page_count: rows.length }];
};

describe('useDocumentExtraction — cache', () => {
    it('restores pages from the DB cache without calling process_document', async () => {
        seedCompleteCache([cachedPageRow([word('w1', 'Hello')])]);
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.extractionResult?.pages[0].text).toBe('cached');
        expect(invoke).not.toHaveBeenCalledWith('process_document', expect.anything());
    });

    it('processes and persists on a cache miss, assigning UUID ids', async () => {
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'process_document')
                return Promise.resolve({
                    session_id: 'sess',
                    pages: [
                        {
                            image_path: '/r1.png',
                            natural_width: 1000,
                            natural_height: 1000,
                            text: 't',
                            words: [{ text: 'A', confidence: 80, box_coords: { left: 0, top: 0, width: 5, height: 5 } }],
                        },
                    ],
                });
            return Promise.resolve(undefined);
        });

        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.extractionResult).not.toBeNull());
        expect(invoke).toHaveBeenCalledWith('process_document', { sessionId: 'sess', filePath: '/doc.pdf', presetId: null });
        // Persisted via INSERT, and a UUID id was attached to the word.
        expect(executed.some(e => e.sql.includes('INSERT OR IGNORE INTO document_pages'))).toBe(true);
        expect(result.current.extractionResult!.pages[0].words[0].id).toBeTruthy();
    });

    // A crash or force-quit partway through the per-page insert loop used to leave a
    // short cache that looked exactly like a finished one — the document would show
    // fewer pages than it has, permanently and silently.
    it('reprocesses instead of trusting a cache that is short of its marker', async () => {
        cachedPages = [cachedPageRow([word('w1', 'page one')])];
        pageSets = [{ page_count: 3 }]; // the write was interrupted after page 1 of 3
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document'
                ? Promise.resolve({ session_id: 'sess', pages: [] })
                : Promise.resolve(undefined),
        );

        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(invoke).toHaveBeenCalledWith('process_document', { sessionId: 'sess', filePath: '/doc.pdf', presetId: null });
        // The wreckage is cleared first — rows, marker and the orphaned render.
        expect(executed.some(e => e.sql.includes('DELETE FROM document_pages'))).toBe(true);
        expect(executed.some(e => e.sql.includes('DELETE FROM document_page_sets'))).toBe(true);
        expect(fsRemove).toHaveBeenCalledWith('/p1.png');
    });

    // Rows with no marker at all are the same wreckage, from a run interrupted before
    // the marker existed.
    it('reprocesses when page rows exist with no marker', async () => {
        cachedPages = [cachedPageRow([word('w1', 'orphan')])];
        pageSets = [];
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document'
                ? Promise.resolve({ session_id: 'sess', pages: [] })
                : Promise.resolve(undefined),
        );

        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(invoke).toHaveBeenCalledWith('process_document', expect.anything());
    });

    it('writes the completeness marker only after every page row', async () => {
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document'
                ? Promise.resolve({
                    session_id: 'sess',
                    pages: [0, 1, 2].map(i => ({
                        image_path: `/r${i}.png`,
                        natural_width: 1000,
                        natural_height: 1000,
                        text: 't',
                        words: [],
                    })),
                })
                : Promise.resolve(undefined),
        );

        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.extractionResult).not.toBeNull());

        const inserts = executed.filter(e => e.sql.includes('INSERT'));
        const marker = inserts.findIndex(e => e.sql.includes('document_page_sets'));
        const lastPage = inserts.map(e => e.sql.includes('INSERT OR IGNORE INTO document_pages')).lastIndexOf(true);
        expect(marker).toBeGreaterThan(lastPage);
        // …and it records the real page count, which is what the next open checks.
        expect(inserts[marker].binds).toEqual(['sess', 3]);
    });

    // The images' paths live in document_pages and nowhere else, so dropping the rows
    // without them left a full set of renders on disk for every retry.
    it('retry() deletes the cached page images before re-rendering', async () => {
        seedCompleteCache([cachedPageRow([word('w1', 'Hello')])]);
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document'
                ? Promise.resolve({ session_id: 'sess', pages: [] })
                : Promise.resolve(undefined),
        );

        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(fsRemove).not.toHaveBeenCalled(); // a good cache is left alone

        act(() => result.current.retry());
        await waitFor(() => expect(fsRemove).toHaveBeenCalledWith('/p1.png'));
        expect(invoke).toHaveBeenCalledWith('process_document', { sessionId: 'sess', filePath: '/doc.pdf', presetId: null });
    });
});

describe('useDocumentExtraction — progress & cancel', () => {
    it('updates progress from a process:progress event', async () => {
        files = [{ file_path: '/doc.pdf' }];
        // process_document stays pending so the event can land mid-flight.
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document' ? new Promise(() => {}) : Promise.resolve(undefined),
        );
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(progressHandler).not.toBeNull());
        act(() => progressHandler!({ payload: { session_id: 'sess', current_page: 2, total_pages: 5 } }));
        await waitFor(() => expect(result.current.progress).toEqual({ current: 2, total: 5 }));
    });

    it('cancel() invokes cancel_process_document and enters the neutral cancelled state', async () => {
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document' ? new Promise(() => {}) : Promise.resolve(undefined),
        );
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.isLoading).toBe(true));
        act(() => result.current.cancel());
        expect(result.current.cancelled).toBe(true);
        expect(result.current.error).toBeNull();
        expect(invoke).toHaveBeenCalledWith('cancel_process_document');
    });

    it('a CANCELLED_MESSAGE rejection sets cancelled (not error)', async () => {
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document'
                ? Promise.reject('Document processing was cancelled.')
                : Promise.resolve(undefined),
        );
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.cancelled).toBe(true));
        expect(result.current.error).toBeNull();
    });

    it('surfaces a real backend error', async () => {
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document' ? Promise.reject('render failed') : Promise.resolve(undefined),
        );
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.error).toBe('render failed'));
        expect(result.current.cancelled).toBe(false);
    });
});

describe('useDocumentExtraction — word edits', () => {
    it('addWord appends via a copied array and bumps sessions.updated_at', async () => {
        seedCompleteCache([cachedPageRow([word('w1', 'Hello')])]);
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.extractionResult).not.toBeNull());

        await act(async () => {
            await result.current.addWord('World', { left: 50, top: 0, width: 10, height: 10 });
        });

        const texts = result.current.extractionResult!.pages[0].words.map(w => w.text);
        expect(texts).toContain('World');
        expect(executed.some(e => e.sql.includes('UPDATE document_pages'))).toBe(true);
        expect(executed.some(e => e.sql.includes('UPDATE sessions SET updated_at'))).toBe(true);
    });

    it('editWord with empty text deletes the word', async () => {
        seedCompleteCache([cachedPageRow([word('w1', 'Hello'), word('w2', 'World')])]);
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.extractionResult).not.toBeNull());

        await act(async () => {
            await result.current.editWord('w1', '   ');
        });

        const ids = result.current.extractionResult!.pages[0].words.map(w => w.id);
        expect(ids).not.toContain('w1');
        expect(ids).toContain('w2');
    });

    it('deleteWord removes the word', async () => {
        seedCompleteCache([cachedPageRow([word('w1', 'Hello'), word('w2', 'World')])]);
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.extractionResult).not.toBeNull());

        await act(async () => {
            await result.current.deleteWord('w2');
        });
        expect(result.current.extractionResult!.pages[0].words.map(w => w.id)).toEqual(['w1']);
    });
});

describe('useDocumentExtraction — retry', () => {
    it('retry() clears cached pages and reprocesses from source, clearing cancelled', async () => {
        // First mount: cancelled.
        files = [{ file_path: '/doc.pdf' }];
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document'
                ? Promise.reject('Document processing was cancelled.')
                : Promise.resolve(undefined),
        );
        const { result } = renderHook(() => useDocumentExtraction('sess', 0));
        await waitFor(() => expect(result.current.cancelled).toBe(true));

        // Now make processing succeed and retry.
        invoke.mockImplementation((cmd: string) =>
            cmd === 'process_document'
                ? Promise.resolve({ session_id: 'sess', pages: [] })
                : Promise.resolve(undefined),
        );
        await act(async () => { result.current.retry(); });
        await waitFor(() => expect(result.current.cancelled).toBe(false));
        // forceReprocess => the cache is dropped before reprocessing.
        expect(executed.some(e => e.sql.includes('DELETE FROM document_pages'))).toBe(true);
    });
});
