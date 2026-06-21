import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams } from 'react-router';
import type { DocumentViewerHandle } from '../components/DocumentViewer';
import type { SelectedCell } from '../components/ProvenanceTable';
import { HelpOverlay } from '../components/HelpOverlay';
import { parseCSV } from '../features/llama/promptUtils';
import { getDb } from '../lib/db';

import { useDocumentExtraction } from '../features/extraction/useDocumentExtraction';
import { useLlamaChat } from '../features/llama/useLlamaChat';
import { LlamaChatProvider } from '../features/llama/LlamaChatContext';
import { SplitLayout } from '../layouts/SplitLayout';
import { generateLinesFromWords } from '../utils/ocrTransforms';
import { sanitizeWordsForProvenance, getCellSourceBox } from '../features/extraction/provenance';
import type { BoundingBox } from '../features/ocr/types';
import type { ProvenanceCell } from '../features/extraction/types';
import { buildFileStem } from '../features/export/exportUtils';
import { copyTableToClipboard } from '../utils/clipboard';
import { SourceDocumentPane } from './session/SourceDocumentPane';
import { ExtractionOutputPane } from './session/ExtractionOutputPane';
import { SourceHelp, OutputHelp } from './session/SessionHelp';

function SessionContent(): React.ReactElement {
    const { id } = useParams<{ id: string }>();
    const [activePageIndex, setActivePageIndex] = useState(0);
    const [sourceFileName, setSourceFileName] = useState<string | null>(null);
    // Which side's help overlay is open, if any.
    const [helpOpen, setHelpOpen] = useState<null | 'source' | 'output'>(null);

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
        deleteWord
    } = useDocumentExtraction(id, activePageIndex);

    const {
        requestTableFormat,
        cancelTableFormat,
        streamingContent,
        isExtracting,
        isCancelling,
        extractionPhase,
        serverError: llamaError,
    } = useLlamaChat();

    // Defer the "Processing…" spinner: a cached session loads from the DB in well
    // under this delay, so it should swap straight to content (faded in by the route
    // transition) rather than flashing a spinner. The spinner only appears if loading
    // genuinely runs long (e.g. first-time OCR of a fresh document).
    const [showProcessing, setShowProcessing] = useState(false);

    const [outputView, setOutputView] = useState<'raw' | 'table'>('raw');
    const [savedCsv, setSavedCsv] = useState<string | null>(null);
    const [provenanceCells, setProvenanceCells] = useState<ProvenanceCell[][] | null>(null);
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
    const [viewTransform, setViewTransform] = useState({ scale: 1, x: 0, y: 0 });
    const [minZoom, setMinZoom] = useState(0.5);
    const viewerRef = useRef<DocumentViewerHandle>(null);
    const [pageInputValue, setPageInputValue] = useState('1');

    const totalPages = extractionResult?.pages.length ?? 1;
    const activePage = extractionResult?.pages[activePageIndex];

    // Reconstruct the reading-ordered lines once; reused for both the rendered
    // text and the copy-to-clipboard payload so they always match.
    const rawLines = useMemo(
        () => (activePage?.words ? generateLinesFromWords(activePage.words, activePage.natural_height) : []),
        [activePage]
    );
    const rawText = useMemo(
        () => rawLines.map(line => line.map(w => w.text).join(' ')).join('\n'),
        [rawLines]
    );

    // Whether a table has been produced for this page yet. Drives the table-tab
    // empty state (centered "Format" button) vs. the populated state (bottom
    // toolbar with export / re-extract).
    const hasTable = (provenanceCells?.length ?? 0) > 0 || !!savedCsv;

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
            setSavedCsv(csv);
            setProvenanceCells(mappingsJson ? JSON.parse(mappingsJson) as ProvenanceCell[][] : null);
            setSelectedCell(null);
            setSelectedWordId(null);
            setProvenanceHighlightBox(null);
            setExtractionError(null);
            setTruncated(false);
            setContextOverflow(false);
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
        setViewTransform({ scale: 1, x: 0, y: 0 });
    };

    // `boostTokens` is set by the truncation banner's Retry to re-run with the full
    // context window (more memory/time, but recovers rows the budget cut off).
    const handleFormatTable = async (boostTokens = false) => {
        if (!fileUrl || !activePage?.words.length || !id) return;
        setOutputView('table');
        setSelectedCell(null);
        setSelectedWordId(null);
        setProvenanceHighlightBox(null);
        setExtractionError(null);
        setTruncated(false);
        setContextOverflow(false);

        try {
            const result = await requestTableFormat(
                fileUrl,
                activePage.words,
                activePage.natural_height,
                id,
                activePageIndex,
                { boostTokens },
            );
            setSavedCsv(result.csvContent);
            setProvenanceCells(result.provenanceCells);
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

    const handleCellClick = (cell: ProvenanceCell) => {
        if (!activePage) return;
        setSelectedWordId(null);
        setSelectedCell({ rowIndex: cell.rowIndex, colIndex: cell.colIndex });
        // Compute source bbox on the fly — sanitization is deterministic and cheap
        const sanitized = sanitizeWordsForProvenance(activePage.words, activePage.natural_height);
        const box = getCellSourceBox(cell, sanitized);
        setProvenanceHighlightBox(box);
    };

    // Word-level selection links the raw-text view and the image 1:1: bold the
    // word in the text, outline that single word's box on the image.
    const selectWord = (wordId: string) => {
        const word = activePage?.words.find(w => w.id === wordId);
        if (!word) return;
        setSelectedCell(null);
        setSelectedWordId(wordId);
        setProvenanceHighlightBox(word.box_coords);
    };

    // Clicking a word on the image links back to whichever right-pane view is
    // showing: in raw mode it selects the matching word, in table mode it selects
    // the cell the word feeds (wordIds are stable UUIDs, so a membership test finds
    // it; routing through handleCellClick keeps highlight box and selection in sync).
    const handleWordClick = (wordId: string) => {
        if (outputView === 'raw') {
            selectWord(wordId);
            return;
        }
        if (!provenanceCells) return;
        for (const row of provenanceCells) {
            const cell = row.find(c => c.wordIds.includes(wordId));
            if (cell) {
                handleCellClick(cell);
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
                viewTransform={viewTransform}
                setViewTransform={setViewTransform}
                minZoom={minZoom}
                setMinZoom={setMinZoom}
                totalPages={totalPages}
                activePageIndex={activePageIndex}
                goToPage={goToPage}
                pageInputValue={pageInputValue}
                setPageInputValue={setPageInputValue}
                onHelp={() => setHelpOpen('source')}
            />

            <>
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
                    isExtracting={isExtracting}
                    isCancelling={isCancelling}
                    extractionPhase={extractionPhase}
                    streamingContent={streamingContent}
                    streamRef={streamRef}
                    cancelTableFormat={cancelTableFormat}
                    provenanceCells={provenanceCells}
                    selectedCell={selectedCell}
                    handleCellClick={handleCellClick}
                    savedCsv={savedCsv}
                    handleCopyTable={handleCopyTable}
                    hasTable={hasTable}
                    extractionError={extractionError}
                    llamaError={llamaError}
                    truncated={truncated}
                    contextOverflow={contextOverflow}
                    handleFormatTable={handleFormatTable}
                    fileStem={buildFileStem(sourceFileName, activePageIndex, totalPages)}
                    onHelp={() => setHelpOpen('output')}
                />

                {/* Help overlays — rendered fixed so they cover the whole window. */}
                {helpOpen === 'source' && (
                    <HelpOverlay title="Source Document" onClose={() => setHelpOpen(null)}>
                        <SourceHelp />
                    </HelpOverlay>
                )}
                {helpOpen === 'output' && (
                    <HelpOverlay title="Extracted Text & Table" onClose={() => setHelpOpen(null)}>
                        <OutputHelp />
                    </HelpOverlay>
                )}
            </>
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
