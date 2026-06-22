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
let files: { file_path: string }[] = [];
const executed: { sql: string; binds: unknown[] }[] = [];

const fakeDb = {
    select: vi.fn(async (sql: string) => {
        if (sql.includes('FROM document_pages')) return cachedPages;
        if (sql.includes('FROM files')) return files;
        return [];
    }),
    execute: vi.fn(async (sql: string, binds: unknown[] = []) => {
        executed.push({ sql, binds });
        return { rowsAffected: 1, lastInsertId: 0 };
    }),
};
vi.mock('../../lib/db', () => ({ getDb: async () => fakeDb }));

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
    files = [];
    executed.length = 0;
    progressHandler = null;
});

describe('useDocumentExtraction — cache', () => {
    it('restores pages from the DB cache without calling process_document', async () => {
        cachedPages = [cachedPageRow([word('w1', 'Hello')])];
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
        expect(invoke).toHaveBeenCalledWith('process_document', { sessionId: 'sess', filePath: '/doc.pdf' });
        // Persisted via INSERT, and a UUID id was attached to the word.
        expect(executed.some(e => e.sql.includes('INSERT OR IGNORE INTO document_pages'))).toBe(true);
        expect(result.current.extractionResult!.pages[0].words[0].id).toBeTruthy();
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
        cachedPages = [cachedPageRow([word('w1', 'Hello')])];
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
        cachedPages = [cachedPageRow([word('w1', 'Hello'), word('w2', 'World')])];
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
        cachedPages = [cachedPageRow([word('w1', 'Hello'), word('w2', 'World')])];
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
