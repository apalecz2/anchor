import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams } from 'react-router';
import type { DocumentViewerHandle } from '../components/DocumentViewer';
import type { SelectedCell } from '../components/ProvenanceTable';
import { parseCSV } from '../features/llama/promptUtils';
import { getDb } from '../lib/db';

import { useDocumentExtraction } from '../features/extraction/useDocumentExtraction';
import { useLlamaChat } from '../features/llama/useLlamaChat';
import { LlamaChatProvider } from '../features/llama/LlamaChatContext';
import { SplitLayout } from '../layouts/SplitLayout';
import { buildReadingOrderText, generateLinesFromWords } from '../utils/ocrTransforms';
import { sanitizeWordsForProvenance, getCellSourceBox, padProvenanceGrid } from '../features/extraction/provenance';
import type { BoundingBox } from '../features/ocr/types';
import type { ProvenanceCell } from '../features/extraction/types';
import { buildFileStem, toCsv } from '../features/export/exportUtils';
import { copyTableToClipboard } from '../utils/clipboard';
import { touchSession } from '../features/sessions/touchSession';
import { SourceDocumentPane } from './session/SourceDocumentPane';
import { ExtractionOutputPane } from './session/ExtractionOutputPane';

function SessionContent(): React.ReactElement {
    const { id } = useParams<{ id: string }>();
    const [activePageIndex, setActivePageIndex] = useState(0);
    const [sourceFileName, setSourceFileName] = useState<string | null>(null);

    const {
        extractionResult,
        fileUrl,
        isLoading: isDbLoading,
        error: dbError,
        cancelled: processingCancelled,
        progress: processProgress,
        retry: retryProcessing,
        cancel: cancelProcessing,
        addWord,
        editWord,
        deleteWord,
        rawTextSaved
    } = useDocumentExtraction(id, activePageIndex);

    const {
        requestTableFormat,
        cancelTableFormat,
        streamingContent,
        isExtracting,
        isCancelling,
        extractionPhase,
    } = useLlamaChat();

    // Defer the "Processing…" spinner: a cached session loads from the DB in well
    // under this delay, so it should swap straight to content (faded in by the route
    // transition) rather than flashing a spinner. The spinner only appears if loading
    // genuinely runs long (e.g. first-time OCR of a fresh document).
    const [showProcessing, setShowProcessing] = useState(false);

    const [outputView, setOutputView] = useState<'raw' | 'table'>('raw');
    const [savedCsv, setSavedCsv] = useState<string | null>(null);
    const [provenanceCells, setProvenanceCells] = useState<ProvenanceCell[][] | null>(null);
    // Counts *wholesale* replacements of the table — a fresh extraction, or a load
    // from the database — as opposed to edits of the one on screen. It is half of
    // the editor's reset key; see `replaceTable`.
    const [tableGeneration, setTableGeneration] = useState(0);
    const [selectedCell, setSelectedCell] = useState<SelectedCell>(null);
    const [provenanceHighlightBox, setProvenanceHighlightBox] = useState<BoundingBox | null>(null);
    const [extractionError, setExtractionError] = useState<string | null>(null);
    const [truncated, setTruncated] = useState(false);
    // The page's prompt is estimated too dense to fit the model's context in one pass.
    const [contextOverflow, setContextOverflow] = useState(false);
    const [highlightedWordId, setHighlightedWordId] = useState<string | null>(null);
    // Persistent (click) word selection that links the raw-text view and the image:
    // the selected word is bolded in the text and outlined on the image.
    const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
    const selectedWordRef = useRef<HTMLSpanElement | null>(null);
    // The streaming-output box is fixed-height; keep it pinned to the bottom so the
    // newest generated tokens stay visible as they arrive.
    const streamRef = useRef<HTMLPreElement | null>(null);
    const [editingState, setEditingState] = useState<{ box?: BoundingBox | null, id?: string, text?: string } | null>(null);

    const [activeTool, setActiveTool] = useState<'draw' | 'pan'>('draw');
    // Which OCR regions are drawn on the source image: 'all' (every region),
    // 'issues' (only lower-confidence ones), or 'none' (overlay hidden).
    const [overlayMode, setOverlayMode] = useState<'all' | 'issues' | 'none'>('all');
    // Viewer zoom, relative to the fitted size (1 = the image exactly fits the
    // pane). The viewer owns pan/centering internally and reports zoom changes
    // (wheel, fit, zoom-to-box) back through setZoom so the toolbar stays in sync.
    const [zoom, setZoom] = useState(1);
    const viewerRef = useRef<DocumentViewerHandle>(null);
    const [pageInputValue, setPageInputValue] = useState('1');

    const totalPages = extractionResult?.pages.length ?? 1;
    const activePage = extractionResult?.pages[activePageIndex];

    // The reading-ordered lines (rendered, word by word, so each stays clickable)
    // and the same content as flat text (copy-to-clipboard, and what gets stored
    // as the page's `full_text`). Both come from `groupWordsIntoLines`, so the
    // copied text always matches what is on screen.
    const rawLines = useMemo(
        () => (activePage?.words ? generateLinesFromWords(activePage.words, activePage.natural_height) : []),
        [activePage]
    );
    const rawText = useMemo(
        () => (activePage?.words ? buildReadingOrderText(activePage.words, activePage.natural_height) : ''),
        [activePage]
    );

    // Whether a table has been produced for this page yet. Drives the table-tab
    // empty state (centered "Format" button) vs. the populated state (bottom
    // toolbar with export / re-extract).
    const hasTable = (provenanceCells?.length ?? 0) > 0 || !!savedCsv;

    /**
     * Put a different table on screen — the result of an extraction, or whatever
     * the database holds for the page being opened.
     *
     * Distinct from `applyCellUpdate` (which commits an *edit* to the table that
     * is already there) because the table editor's undo stack is over one
     * specific grid. Re-extracting replaced the grid without changing
     * `session:page`, so the stack survived: pressing Undo once afterwards wrote
     * the pre-extraction table back over the new one and persisted it. Bumping
     * the generation here is what tells the editor the thing underneath it is a
     * different table now, so it starts with clean history.
     */
    const replaceTable = (csv: string | null, cells: ProvenanceCell[][] | null) => {
        setSavedCsv(csv);
        setProvenanceCells(cells);
        setTableGeneration(generation => generation + 1);
    };

    /**
     * Drop everything that describes the table currently on screen: the cell/word
     * selection with its image highlight, and the three banners the last extraction
     * left behind (error, truncation, context overflow).
     *
     * Called wherever the table underneath is about to be replaced — loading a
     * different page's saved table, or starting a fresh extraction. Each of those
     * has to clear *all* of it: a `selectedCell` kept across the swap points at a
     * row that may not exist in the new grid, and a stale error banner sits above a
     * table that just extracted cleanly.
     */
    const clearTableView = () => {
        setSelectedCell(null);
        setSelectedWordId(null);
        setProvenanceHighlightBox(null);
        setExtractionError(null);
        setTruncated(false);
        setContextOverflow(false);
    };

    // Copy handlers throw on failure so CopyButton can keep its confirmation state
    // accurate; CopyButton owns the transient "Copied" UI.
    const handleCopyRawText = () => navigator.clipboard.writeText(rawText);
    const handleCopyTable = () => copyTableToClipboard(parseCSV(savedCsv ?? ''));

    useEffect(() => {
        setPageInputValue((activePageIndex + 1).toString());
    }, [activePageIndex]);

    // Only reveal the processing spinner if loading outlasts a short grace period,
    // so fast cached loads don't flash it. Reset immediately once loading finishes.
    useEffect(() => {
        if (!isDbLoading) {
            setShowProcessing(false);
            return;
        }
        const timer = setTimeout(() => setShowProcessing(true), 250);
        return () => clearTimeout(timer);
    }, [isDbLoading]);

    // Reveal the selected word in the raw-text view when the selection comes from
    // clicking its box on the image (it may be scrolled out of the text viewport).
    useEffect(() => {
        selectedWordRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [selectedWordId]);

    // Keep the fixed-height streaming box scrolled to the latest tokens.
    useEffect(() => {
        const el = streamRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [streamingContent]);

    // Load source filename once per session for descriptive export names
    useEffect(() => {
        if (!id) return;
        getDb().then(db =>
            db.select<{ file_name: string }[]>(
                'SELECT file_name FROM files WHERE session_id = $1 LIMIT 1',
                [id]
            )
        ).then(rows => {
            setSourceFileName(rows[0]?.file_name ?? null);
        }).catch(() => { /* non-critical */ });
    }, [id]);

    // Load saved CSV + provenance from DB when session/page changes
    useEffect(() => {
        if (!id) return;
        let cancelled = false;
        async function load() {
            const db = await getDb();
            const rows = await db.select<{ csv_content: string; cell_mappings_json: string | null }[]>(
                'SELECT csv_content, cell_mappings_json FROM csv_outputs WHERE session_id = $1 AND page_index = $2',
                [id, activePageIndex]
            );
            if (cancelled) return;
            const csv = rows[0]?.csv_content ?? null;
            const mappingsJson = rows[0]?.cell_mappings_json ?? null;
            // Pad ragged grids (the model may omit trailing empty cells; older
            // sessions persisted them that way) so the last column always renders.
            replaceTable(csv, mappingsJson ? padProvenanceGrid(JSON.parse(mappingsJson) as ProvenanceCell[][]) : null);
            clearTableView();
            if (csv) setOutputView('table');
        }
        load();
        return () => { cancelled = true; };
    }, [id, activePageIndex]);

    const goToPage = (index: number) => {
        setActivePageIndex(index);
        setHighlightedWordId(null);
        setEditingState(null);
        setSelectedCell(null);
        setSelectedWordId(null);
        setProvenanceHighlightBox(null);
        setZoom(1);
    };

    // `boostTokens` is set by the truncation banner's Retry to re-run with the full
    // context window (more memory/time, but recovers rows the budget cut off).
    const handleFormatTable = async (boostTokens = false) => {
        if (!fileUrl || !activePage?.words.length || !id) return;
        setOutputView('table');
        clearTableView();

        try {
            const result = await requestTableFormat(
                fileUrl,
                activePage.words,
                activePage.natural_height,
                id,
                activePageIndex,
                { boostTokens },
            );
            replaceTable(result.csvContent, padProvenanceGrid(result.provenanceCells));
            setTruncated(result.truncated);
            setContextOverflow(result.contextOverflow);
        } catch (err) {
            // A user-initiated cancel isn't a failure — just unwind to the prior view
            // (a previous table stays shown, otherwise the empty state) without an error.
            if ((err as { name?: string })?.name === 'AbortError') return;
            // Surface the failure instead of leaving the pane on a stale prompt.
            setExtractionError(err instanceof Error ? err.message : 'Extraction failed. Please try again.');
        }
    };

    // `autoZoom` is suppressed when the click originated on the image itself
    // (via handleWordClick below) — the box is already visible there, so
    // re-centering/zooming the viewport under the cursor would just be
    // disorienting. It's only useful when the selection comes from the table
    // or raw-text list, where the source box may be off-screen or too small.
    const handleCellClick = (cell: ProvenanceCell, opts: { autoZoom?: boolean } = {}) => {
        const { autoZoom = true } = opts;
        if (!activePage) return;
        setSelectedWordId(null);
        setSelectedCell({ rowIndex: cell.rowIndex, colIndex: cell.colIndex });
        // Compute source bbox on the fly — sanitization is deterministic and cheap
        const sanitized = sanitizeWordsForProvenance(activePage.words, activePage.natural_height);
        const box = getCellSourceBox(cell, sanitized);
        setProvenanceHighlightBox(box);
        if (box && autoZoom) viewerRef.current?.zoomToBox(box);
    };

    // Drop the table selection (and with it the source highlight it drives).
    // Clearing the anchor here is what clears the editor's range too — the
    // editor follows this selection and collapses to nothing when it goes away.
    const clearCellSelection = () => {
        setSelectedCell(null);
        setProvenanceHighlightBox(null);
    };

    // Apply an updated cell grid: refresh both pieces of table state (the CSV is
    // re-derived from the cells so copy/export always reflect edits) and persist
    // them over the existing csv_outputs row. Called only while a table exists,
    // so the UPDATE always has a row to hit; a failed write keeps the in-memory
    // edit and logs rather than blanking the pane.
    //
    // Every table edit — a typed value, an inserted row, an undo — arrives here
    // as a whole replacement grid (see useTableEditor), so this is the single
    // write path for the formatted table.
    const applyCellUpdate = (updated: ProvenanceCell[][]) => {
        const csv = toCsv(updated.map(row => row.map(c => c.value)));
        setProvenanceCells(updated);
        setSavedCsv(csv);
        if (!id) return;
        getDb().then(async db => {
            await db.execute(
                'UPDATE csv_outputs SET csv_content = $1, cell_mappings_json = $2 WHERE session_id = $3 AND page_index = $4',
                [csv, JSON.stringify(updated), id, activePageIndex]
            );
            await touchSession(id);
        }).catch(err => console.error('Failed to persist cell update', err));
    };

    // Word-level selection links the raw-text view and the image 1:1: bold the
    // word in the text, outline that single word's box on the image.
    const selectWord = (wordId: string, opts: { autoZoom?: boolean } = {}) => {
        const { autoZoom = true } = opts;
        const word = activePage?.words.find(w => w.id === wordId);
        if (!word) return;
        setSelectedCell(null);
        setSelectedWordId(wordId);
        setProvenanceHighlightBox(word.box_coords);
        if (autoZoom) viewerRef.current?.zoomToBox(word.box_coords);
    };

    // Clicking a word on the image links back to whichever right-pane view is
    // showing: in raw mode it selects the matching word, in table mode it selects
    // the cell the word feeds (wordIds are stable UUIDs, so a membership test finds
    // it; routing through handleCellClick keeps highlight box and selection in sync).
    // autoZoom is off here — the clicked word is already visible on the image.
    const handleWordClick = (wordId: string) => {
        if (outputView === 'raw') {
            selectWord(wordId, { autoZoom: false });
            return;
        }
        if (!provenanceCells) return;
        for (const row of provenanceCells) {
            const cell = row.find(c => c.wordIds.includes(wordId));
            if (cell) {
                handleCellClick(cell, { autoZoom: false });
                return;
            }
        }
    };

    return (
        <SplitLayout>
            <SourceDocumentPane
                isDbLoading={isDbLoading}
                showProcessing={showProcessing}
                processProgress={processProgress}
                processingCancelled={processingCancelled}
                dbError={dbError}
                cancelProcessing={cancelProcessing}
                retryProcessing={retryProcessing}
                fileUrl={fileUrl}
                activePage={activePage}
                viewerRef={viewerRef}
                addWord={addWord}
                editWord={editWord}
                deleteWord={deleteWord}
                editingState={editingState}
                setEditingState={setEditingState}
                highlightedWordId={highlightedWordId}
                setHighlightedWordId={setHighlightedWordId}
                onWordClick={handleWordClick}
                provenanceHighlightBox={provenanceHighlightBox}
                activeTool={activeTool}
                setActiveTool={setActiveTool}
                zoom={zoom}
                setZoom={setZoom}
                overlayMode={overlayMode}
                setOverlayMode={setOverlayMode}
                totalPages={totalPages}
                activePageIndex={activePageIndex}
                goToPage={goToPage}
                pageInputValue={pageInputValue}
                setPageInputValue={setPageInputValue}
            />

            <ExtractionOutputPane
                outputView={outputView}
                setOutputView={setOutputView}
                activePage={activePage}
                isDbLoading={isDbLoading}
                showProcessing={showProcessing}
                processingCancelled={processingCancelled}
                rawLines={rawLines}
                selectedWordId={selectedWordId}
                highlightedWordId={highlightedWordId}
                setHighlightedWordId={setHighlightedWordId}
                selectWord={selectWord}
                selectedWordRef={selectedWordRef}
                handleCopyRawText={handleCopyRawText}
                rawTextSaved={rawTextSaved}
                isExtracting={isExtracting}
                isCancelling={isCancelling}
                extractionPhase={extractionPhase}
                streamingContent={streamingContent}
                streamRef={streamRef}
                cancelTableFormat={cancelTableFormat}
                provenanceCells={provenanceCells}
                selectedCell={selectedCell}
                handleCellClick={handleCellClick}
                clearCellSelection={clearCellSelection}
                onApplyGrid={applyCellUpdate}
                tableKey={`${id ?? 'none'}:${activePageIndex}:${tableGeneration}`}
                savedCsv={savedCsv}
                handleCopyTable={handleCopyTable}
                hasTable={hasTable}
                extractionError={extractionError}
                truncated={truncated}
                contextOverflow={contextOverflow}
                handleFormatTable={handleFormatTable}
                fileStem={buildFileStem(sourceFileName, activePageIndex, totalPages)}
            />
        </SplitLayout>
    );
}

export default function Session(): React.ReactElement {
    return (
        <LlamaChatProvider>
            <SessionContent />
        </LlamaChatProvider>
    );
}
