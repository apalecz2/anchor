import { useState, useEffect, useRef } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getDb } from '../../lib/db';
import { ExtractionResult, DocumentPageResult } from './types';
import type { BoundingBox } from '../ocr/types';
import { sortWords, generateLinesFromWords } from '../../utils/ocrTransforms';

export type ProcessProgress = { current: number; total: number };

// Must match CANCELLED_MESSAGE in src-tauri/src/ocr.rs — the backend rejects a
// cancelled job with this exact string so we can show a neutral state, not a failure.
const CANCELLED_MESSAGE = 'Document processing was cancelled.';

export function useDocumentExtraction(sessionId: string | undefined, activePageIndex: number = 0) {
    const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [cancelled, setCancelled] = useState(false);
    const [progress, setProgress] = useState<ProcessProgress | null>(null);
    const [retryToken, setRetryToken] = useState(0);
    const hasProcessed = useRef(false);
    // Set by retry() to bypass the page cache and re-run OCR from the source file.
    const forceReprocess = useRef(false);

    useEffect(() => {
        let unlistenProgress: (() => void) | undefined;

        async function processDocument() {
            if (!sessionId || hasProcessed.current) return;
            hasProcessed.current = true;

            try {
                setError(null);
                setCancelled(false);
                setIsLoading(true);
                const db = await getDb();

                // On an explicit retry, drop any cached pages so the source file is
                // actually re-rendered (e.g. after a transient per-page failure).
                if (forceReprocess.current) {
                    await db.execute('DELETE FROM document_pages WHERE session_id = $1', [sessionId]);
                    forceReprocess.current = false;
                }

                const cachedPages = await db.select<any[]>(
                    'SELECT image_path, natural_width, natural_height, full_text, words_json FROM document_pages WHERE session_id = $1 ORDER BY page_index ASC',
                    [sessionId]
                );

                if (cachedPages && cachedPages.length > 0) {
                    const restoredPages: DocumentPageResult[] = cachedPages.map(page => ({
                        image_path: page.image_path,
                        natural_width: page.natural_width,
                        natural_height: page.natural_height,
                        text: page.full_text,
                        words: JSON.parse(page.words_json)
                    }));
                    setExtractionResult({ session_id: sessionId, pages: restoredPages });
                    return;
                }

                const dbResult = await db.select<{ file_path: string }[]>('SELECT file_path FROM files WHERE session_id = $1 LIMIT 1', [sessionId]);
                if (!dbResult || dbResult.length === 0) throw new Error('No document attached to this session.');

                // Surface per-page progress emitted by the backend so a long PDF
                // shows "Processing page x of y" instead of a static spinner.
                unlistenProgress = await listen<{ session_id: string; current_page: number; total_pages: number }>(
                    'process:progress',
                    event => {
                        if (event.payload.session_id === sessionId) {
                            setProgress({ current: event.payload.current_page, total: event.payload.total_pages });
                        }
                    }
                );

                const rustResult = await invoke<ExtractionResult>('process_document', {
                    sessionId,
                    filePath: dbResult[0].file_path
                });

                for (let i = 0; i < rustResult.pages.length; i++) {
                    const page = rustResult.pages[i];
                    page.words = sortWords(page.words.map(w => ({ ...w, id: crypto.randomUUID() })), page.natural_height);

                    // Persist successful and failed pages alike so the page count and
                    // indices stay consistent; an errored page has no words/image and
                    // simply renders as empty until the user retries.
                    await db.execute(
                        `INSERT OR IGNORE INTO document_pages (id, session_id, page_index, image_path, natural_width, natural_height, full_text, words_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [crypto.randomUUID(), sessionId, i, page.image_path, page.natural_width, page.natural_height, page.text, JSON.stringify(page.words)]
                    );
                }

                setExtractionResult(rustResult);

            } catch (err) {
                // Tauri rejects invoke() with a plain string, not an Error, so don't
                // discard it — surface the real backend message.
                const message =
                    err instanceof Error ? err.message
                    : typeof err === 'string' ? err
                    : 'Failed to process document.';
                // A user-initiated cancel is not a failure — show a neutral state with
                // a retry rather than a red error banner.
                if (message === CANCELLED_MESSAGE) {
                    setCancelled(true);
                } else {
                    setError(message);
                }
                hasProcessed.current = false;
            } finally {
                setIsLoading(false);
                setProgress(null);
            }
        }
        processDocument();

        return () => { unlistenProgress?.(); };
        // retryToken bump re-runs processing after retry() resets hasProcessed.
    }, [sessionId, retryToken]);

    // Re-run document processing after a failure or cancellation (document- or
    // page-level). Resets the one-shot guard and re-triggers the effect via the token.
    const retry = () => {
        if (!sessionId) return;
        hasProcessed.current = false;
        forceReprocess.current = true;
        setError(null);
        setCancelled(false);
        setRetryToken(token => token + 1);
    };

    // Ask the backend to abort an in-flight process_document. The running invoke()
    // then rejects with CANCELLED_MESSAGE, which the catch above turns into `cancelled`.
    const cancel = () => {
        invoke('cancel_process_document').catch(err => console.error('Failed to cancel processing:', err));
    };

    const updateDb = async (updatedPage: DocumentPageResult) => {
        if (!sessionId || !extractionResult) return;
        const lines = generateLinesFromWords(updatedPage.words, updatedPage.natural_height);
        updatedPage.text = lines.map(line => line.map(w => w.text).join(' ')).join('\n');

        // Copy the pages array rather than mutating the existing state object in
        // place, so React sees a new reference and dependent memos/effects re-run.
        const newPages = [...extractionResult.pages];
        newPages[activePageIndex] = updatedPage;
        setExtractionResult({ ...extractionResult, pages: newPages });

        try {
            const db = await getDb();
            await db.execute(
                `UPDATE document_pages SET words_json = $1, full_text = $2 WHERE session_id = $3 AND page_index = $4`,
                [JSON.stringify(updatedPage.words), updatedPage.text, sessionId, activePageIndex]
            );
            // Editing OCR words is meaningful activity — keep the session's last-updated
            // time (used by "Recent"/Search ordering) in sync with the edit.
            await db.execute('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [sessionId]);
        } catch (err) {
            console.error("Failed to update db:", err);
        }
    };

    const addWord = async (text: string, box: BoundingBox) => {
        if (!extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[activePageIndex]);
        updatedPage.words = sortWords([
            ...updatedPage.words,
            {
                id: crypto.randomUUID(),
                text,
                confidence: 100,
                box_coords: box,
            },
        ], updatedPage.natural_height);
        await updateDb(updatedPage);
    };

    const editWord = async (id: string, text: string) => {
        if (!extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[activePageIndex]);
        const idx = updatedPage.words.findIndex(w => w.id === id);
        if (idx === -1) return;
        if (text.trim() === "") {
            updatedPage.words.splice(idx, 1);
        } else {
            updatedPage.words[idx].text = text.trim();
            updatedPage.words[idx].confidence = 100;
        }
        await updateDb(updatedPage);
    };

    const deleteWord = async (id: string) => {
        if (!extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[activePageIndex]);
        const idx = updatedPage.words.findIndex(w => w.id === id);
        if (idx === -1) return;
        updatedPage.words.splice(idx, 1);
        await updateDb(updatedPage);
    };

    const fileUrl = extractionResult?.pages[activePageIndex]?.image_path
        ? convertFileSrc(extractionResult.pages[activePageIndex].image_path)
        : null;

    return { extractionResult, fileUrl, isLoading, error, cancelled, progress, retry, cancel, addWord, editWord, deleteWord };
}