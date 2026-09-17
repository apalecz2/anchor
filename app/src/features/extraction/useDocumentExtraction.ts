import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readFile } from '@tauri-apps/plugin-fs';
import { getDb } from '../../lib/db';
import { touchSession } from '../sessions/touchSession';
import { discardCachedPages } from '../sessions/sessionActions';
import { ExtractionResult, DocumentPageResult } from './types';
import type { BoundingBox } from '../ocr/types';
import { sortWords, buildReadingOrderText } from '../../utils/ocrTransforms';

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
    // True once the in-memory OCR words match what's persisted in document_pages.
    // Flips false the instant a word edit updates local state, and back to true only
    // after the DB write actually completes — surfaced in the UI as a real save status,
    // not an optimistic one.
    const [rawTextSaved, setRawTextSaved] = useState(false);
    const hasProcessed = useRef(false);
    // Set by retry() to bypass the page cache and re-run OCR from the source file.
    const forceReprocess = useRef(false);
    // Set the instant the user cancels. A single-page render/OCR is one uninterruptible
    // backend call, so a result may still arrive after the cancel — this flag lets us
    // discard it (and skip persisting it) instead of replacing the cancelled UI.
    const cancelledRef = useRef(false);

    useEffect(() => {
        let unlistenProgress: (() => void) | undefined;

        async function processDocument() {
            if (!sessionId || hasProcessed.current) return;
            hasProcessed.current = true;

            try {
                setError(null);
                setCancelled(false);
                cancelledRef.current = false;
                setIsLoading(true);
                const db = await getDb();

                // On an explicit retry, drop any cached pages so the source file is
                // actually re-rendered (e.g. after a transient per-page failure).
                // Goes through discardCachedPages so the page images go with the
                // rows — nothing else records their paths, so rows deleted on their
                // own strand the PNGs for good.
                if (forceReprocess.current) {
                    forceReprocess.current = false;
                    await discardCachedPages(sessionId);
                }

                const [cachedPages, pageSets] = await Promise.all([
                    db.select<any[]>(
                        'SELECT image_path, natural_width, natural_height, full_text, words_json FROM document_pages WHERE session_id = $1 ORDER BY page_index ASC',
                        [sessionId]
                    ),
                    db.select<{ page_count: number }[]>(
                        'SELECT page_count FROM document_page_sets WHERE session_id = $1',
                        [sessionId]
                    ),
                ]);

                // The cache is usable only if it is *complete*. Pages are inserted one
                // row at a time (no usable transaction — see db.ts), so an interrupted
                // write leaves a short set that looks exactly like a finished one; the
                // document would then show fewer pages than it has, permanently and
                // silently. `document_page_sets` is written last, after every page row
                // has landed, which is what makes its count trustworthy here.
                const expectedPages = pageSets?.[0]?.page_count ?? null;
                if (expectedPages !== null && (cachedPages?.length ?? 0) === expectedPages) {
                    const restoredPages: DocumentPageResult[] = cachedPages.map(page => ({
                        image_path: page.image_path,
                        natural_width: page.natural_width,
                        natural_height: page.natural_height,
                        text: page.full_text,
                        words: JSON.parse(page.words_json)
                    }));
                    setExtractionResult({ session_id: sessionId, pages: restoredPages });
                    setRawTextSaved(true);
                    return;
                }

                // Rows without a matching marker are the wreckage of an interrupted
                // write. They can't be trusted and can't be completed in place, so
                // clear them (and their images) before re-rendering — leaving them
                // would make the INSERT OR IGNORE below skip the very pages we are
                // re-rendering, and strand the new images.
                if ((cachedPages?.length ?? 0) > 0 || expectedPages !== null) {
                    await discardCachedPages(sessionId);
                }

                const dbResult = await db.select<{ file_path: string }[]>('SELECT file_path FROM files WHERE session_id = $1 LIMIT 1', [sessionId]);
                if (!dbResult || dbResult.length === 0) throw new Error('No document attached to this session.');

                // Surface per-page progress emitted by the backend so a long PDF
                // shows "Processing page x of y" instead of a static spinner.
                unlistenProgress = await listen<{ session_id: string; current_page: number; total_pages: number }>(
                    'process:progress',
                    event => {
                        if (cancelledRef.current) return;
                        if (event.payload.session_id === sessionId) {
                            setProgress({ current: event.payload.current_page, total: event.payload.total_pages });
                        }
                    }
                );

                const rustResult = await invoke<ExtractionResult>('process_document', {
                    sessionId,
                    filePath: dbResult[0].file_path,
                    presetId: null // the catalog's default until a picker exists (mirrors useLlamaChat.ts)
                });

                // The user cancelled while the backend was still working: drop the
                // result and don't persist it — the UI is already showing the
                // cancelled state, and a retry will reprocess from the source.
                if (cancelledRef.current) return;

                for (let i = 0; i < rustResult.pages.length; i++) {
                    const page = rustResult.pages[i];
                    page.words = sortWords(page.words.map(w => ({ ...w, id: crypto.randomUUID() })), page.natural_height);
                    // Derive the readable text from the words rather than storing what
                    // the backend handed us: `process_document` returns Tesseract's raw
                    // `image_to_data` output, which is the TSV *data table* (header row
                    // and all), not text a person or a search query could use. Built
                    // here — and by the same function `updateDb` uses — so the column
                    // means one thing from the first write onward.
                    page.text = buildReadingOrderText(page.words, page.natural_height);

                    // Persist successful and failed pages alike so the page count and
                    // indices stay consistent; an errored page has no words/image and
                    // simply renders as empty until the user retries.
                    await db.execute(
                        `INSERT OR IGNORE INTO document_pages (id, session_id, page_index, image_path, natural_width, natural_height, full_text, words_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [crypto.randomUUID(), sessionId, i, page.image_path, page.natural_width, page.natural_height, page.text, JSON.stringify(page.words)]
                    );
                }

                // The completeness marker, written strictly last: it is what makes the
                // cache readable at all, so it must not exist until every page row
                // above does. Interrupt this loop anywhere and the next open finds
                // rows with no marker, discards them, and re-renders from the source.
                await db.execute(
                    'INSERT OR REPLACE INTO document_page_sets (session_id, page_count) VALUES ($1, $2)',
                    [sessionId, rustResult.pages.length]
                );

                setExtractionResult(rustResult);
                setRawTextSaved(true);

            } catch (err) {
                // A cancel already moved the UI to its neutral cancelled state, so
                // ignore any late rejection from the abandoned backend job.
                if (cancelledRef.current) return;
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
        cancelledRef.current = false;
        setError(null);
        setCancelled(false);
        setRetryToken(token => token + 1);
    };

    // Cancel an in-flight process_document. We respond immediately rather than waiting
    // for the backend to reach its next cancellation checkpoint: flip the UI to the
    // cancelled state now, and ask the backend to abort. The generation bump stops a
    // multi-page job at the next page boundary; a single-page render/OCR can't be
    // interrupted mid-call, so its result is discarded by the cancelledRef guard above.
    const cancel = () => {
        if (cancelledRef.current) return;
        cancelledRef.current = true;
        setCancelled(true);
        setIsLoading(false);
        setProgress(null);
        invoke('cancel_process_document').catch(err => console.error('Failed to cancel processing:', err));
    };

    const updateDb = async (updatedPage: DocumentPageResult) => {
        if (!sessionId || !extractionResult) return;
        updatedPage.text = buildReadingOrderText(updatedPage.words, updatedPage.natural_height);

        // Copy the pages array rather than mutating the existing state object in
        // place, so React sees a new reference and dependent memos/effects re-run.
        const newPages = [...extractionResult.pages];
        newPages[activePageIndex] = updatedPage;
        setExtractionResult({ ...extractionResult, pages: newPages });
        setRawTextSaved(false);

        try {
            const db = await getDb();
            await db.execute(
                `UPDATE document_pages SET words_json = $1, full_text = $2 WHERE session_id = $3 AND page_index = $4`,
                [JSON.stringify(updatedPage.words), updatedPage.text, sessionId, activePageIndex]
            );
            // Editing OCR words is meaningful activity — keep the session's last-updated
            // time (used by "Recent"/Search ordering) in sync with the edit.
            await touchSession(sessionId);
            setRawTextSaved(true);
        } catch (err) {
            console.error("Failed to update db:", err);
        }
    };

    /**
     * Apply an edit to the active page's OCR words and persist it.
     *
     * The clone is the point: `edit` mutates freely (splice, field assignment),
     * and `updateDb` needs a page object React has never rendered, or the state
     * update it does would be a no-op reference-wise. `edit` returning false
     * abandons the write — the word it was looking for isn't there, so there is
     * nothing to save.
     */
    const editActivePageWords = async (
        edit: (page: DocumentPageResult) => boolean | void
    ) => {
        if (!extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[activePageIndex]);
        if (edit(updatedPage) === false) return;
        await updateDb(updatedPage);
    };

    const addWord = (text: string, box: BoundingBox) =>
        editActivePageWords(page => {
            page.words = sortWords([
                ...page.words,
                {
                    id: crypto.randomUUID(),
                    text,
                    confidence: 100,
                    box_coords: box,
                },
            ], page.natural_height);
        });

    const editWord = (id: string, text: string) =>
        editActivePageWords(page => {
            const idx = page.words.findIndex(w => w.id === id);
            if (idx === -1) return false;
            // An emptied word is a deletion — the editor's "clear the text and
            // commit" is how a mis-OCR'd speck gets removed.
            if (text.trim() === "") {
                page.words.splice(idx, 1);
            } else {
                page.words[idx].text = text.trim();
                page.words[idx].confidence = 100;
            }
        });

    const deleteWord = (id: string) =>
        editActivePageWords(page => {
            const idx = page.words.findIndex(w => w.id === id);
            if (idx === -1) return false;
            page.words.splice(idx, 1);
        });

    // Load the active page image as a same-origin blob URL rather than handing
    // the viewer a convertFileSrc `asset://` URL. On macOS the asset protocol is
    // a WKWebView custom scheme, and the viewer's <img> needs to sample pixels on
    // a canvas — which against that scheme means a crossOrigin request, and those
    // fail CORS in WKWebView, so the image never paints. Reading the bytes
    // ourselves sidesteps the protocol entirely and keeps the canvas same-origin
    // on every platform, so the <img> must carry no `crossOrigin` at all.
    const imagePath = extractionResult?.pages[activePageIndex]?.image_path ?? null;
    const [fileUrl, setFileUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!imagePath) {
            setFileUrl(null);
            return;
        }
        let objectUrl: string | null = null;
        let cancelled = false;
        (async () => {
            try {
                const bytes = await readFile(imagePath);
                if (cancelled) return;
                objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
                setFileUrl(objectUrl);
            } catch {
                if (!cancelled) setFileUrl(null);
            }
        })();
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [imagePath]);

    return { extractionResult, fileUrl, isLoading, error, cancelled, progress, retry, cancel, addWord, editWord, deleteWord, rawTextSaved };
}