import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router';
import DocumentViewer from '../components/DocumentViewer';
import type { DocumentViewerHandle } from '../components/DocumentViewer';
import ProvenanceTable from '../components/ProvenanceTable';
import type { SelectedCell } from '../components/ProvenanceTable';
import { parseCSV } from '../features/llama/promptUtils';
import { getDb } from '../lib/db';

import { useDocumentExtraction } from '../features/extraction/useDocumentExtraction';
import { useLlamaChat } from '../features/llama/useLlamaChat';
import { LlamaChatProvider } from '../features/llama/LlamaChatContext';
import { SplitLayout } from '../layouts/SplitLayout';
import { WordEditModal } from '../features/extraction/WordEditModal';
import { generateLinesFromWords } from '../utils/ocrTransforms';
import { sanitizeWordsForProvenance } from '../features/extraction/provenance';
import { getCellSourceBox } from '../features/extraction/provenance';
import type { BoundingBox } from '../features/ocr/types';
import type { ProvenanceCell } from '../features/extraction/types';
import { ExportMenu } from '../features/export/ExportMenu';
import { buildFileStem } from '../features/export/exportUtils';

function SessionContent(): React.ReactElement {
    const { id } = useParams<{ id: string }>();
    const [activePageIndex, setActivePageIndex] = useState(0);
    const [sourceFileName, setSourceFileName] = useState<string | null>(null);

    const {
        extractionResult,
        fileUrl,
        isLoading: isDbLoading,
        error: dbError,
        progress: processProgress,
        retry: retryProcessing,
        addWord,
        editWord,
        deleteWord
    } = useDocumentExtraction(id, activePageIndex);

    const {
        requestTableFormat,
        streamingContent,
        isExtracting,
        serverError: llamaError,
    } = useLlamaChat();

    const [outputView, setOutputView] = useState<'raw' | 'table'>('raw');
    const [savedCsv, setSavedCsv] = useState<string | null>(null);
    const [provenanceCells, setProvenanceCells] = useState<ProvenanceCell[][] | null>(null);
    const [selectedCell, setSelectedCell] = useState<SelectedCell>(null);
    const [provenanceHighlightBox, setProvenanceHighlightBox] = useState<BoundingBox | null>(null);
    const [extractionError, setExtractionError] = useState<string | null>(null);
    const [truncated, setTruncated] = useState(false);
    const [highlightedWordId, setHighlightedWordId] = useState<string | null>(null);
    // Persistent (click) word selection that links the raw-text view and the image:
    // the selected word is bolded in the text and outlined on the image.
    const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
    const selectedWordRef = useRef<HTMLSpanElement | null>(null);
    const [editingState, setEditingState] = useState<{ box?: BoundingBox | null, id?: string, text?: string } | null>(null);

    const [activeTool, setActiveTool] = useState<'draw' | 'pan'>('draw');
    const [viewTransform, setViewTransform] = useState({ scale: 1, x: 0, y: 0 });
    const [minZoom, setMinZoom] = useState(0.5);
    const viewerRef = useRef<DocumentViewerHandle>(null);
    const [pageInputValue, setPageInputValue] = useState('1');

    const totalPages = extractionResult?.pages.length ?? 1;
    const activePage = extractionResult?.pages[activePageIndex];

    useEffect(() => {
        setPageInputValue((activePageIndex + 1).toString());
    }, [activePageIndex]);

    // Reveal the selected word in the raw-text view when the selection comes from
    // clicking its box on the image (it may be scrolled out of the text viewport).
    useEffect(() => {
        selectedWordRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [selectedWordId]);

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

    const commitPageInput = () => {
        const parsed = parseInt(pageInputValue, 10);
        if (!isNaN(parsed)) {
            goToPage(Math.min(Math.max(parsed - 1, 0), totalPages - 1));
        } else {
            setPageInputValue((activePageIndex + 1).toString());
        }
    };


    const handleFormatTable = async () => {
        if (!fileUrl || !activePage?.words.length || !id) return;
        setOutputView('table');
        setSelectedCell(null);
        setSelectedWordId(null);
        setProvenanceHighlightBox(null);
        setExtractionError(null);
        setTruncated(false);

        try {
            const result = await requestTableFormat(
                fileUrl,
                activePage.words,
                activePage.natural_height,
                id,
                activePageIndex,
            );
            setSavedCsv(result.csvContent);
            setProvenanceCells(result.provenanceCells);
            setTruncated(result.truncated);
        } catch (err) {
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

    const handleSaveWord = (text: string) => {
        if (editingState?.id !== undefined) {
            editWord(editingState.id, text);
        } else if (editingState?.box) {
            addWord(text, editingState.box);
        }
        setEditingState(null);
    };

    // Shared style for the square icon buttons in the document toolbar
    const iconBtnClass = "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-variant text-on-surface transition-colors shadow-sm hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20";

    return (
        <SplitLayout>
            {/* LEFT PANE */}
            <>
                <div className="mb-4 flex min-h-[40px] items-center">
                    <h2 className="font-headline-md text-headline-md text-primary truncate">Source Document</h2>
                </div>
                <div className="relative flex-1 overflow-hidden rounded-2xl border border-outline-variant bg-surface-bright shadow-sm">
                    {isDbLoading ? (
                        <div className="flex w-full flex-col items-center justify-center gap-3 h-full text-on-surface-variant">
                            <span className="material-symbols-outlined animate-spin" style={{ fontSize: '28px' }}>progress_activity</span>
                            <span className="text-sm">
                                {processProgress
                                    ? `Processing page ${processProgress.current} of ${processProgress.total}…`
                                    : 'Processing…'}
                            </span>
                        </div>
                    ) : dbError ? (
                        <div className="flex w-full flex-col items-center justify-center gap-3 text-error h-full">
                            <span className="material-symbols-outlined" style={{ fontSize: '28px' }} aria-hidden="true">error</span>
                            <p className="text-sm text-center max-w-sm">{dbError}</p>
                            <button onClick={retryProcessing} className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90">Retry</button>
                        </div>
                    ) : fileUrl && activePage ? (
                        <DocumentViewer
                            ref={viewerRef}
                            fileUrl={fileUrl}
                            words={activePage.words}
                            onAddWord={(box) => setEditingState({ box })}
                            onEditRequest={(id, currentText) => setEditingState({ id, text: currentText })}
                            onDeleteRequest={deleteWord}
                            highlightedWordId={highlightedWordId}
                            setHighlightedWordId={setHighlightedWordId}
                            onWordClick={handleWordClick}
                            activeTool={activeTool}
                            transform={viewTransform}
                            setTransform={setViewTransform}
                            onMinScaleChange={setMinZoom}
                            provenanceHighlightBox={provenanceHighlightBox}
                        />
                    ) : activePage?.error ? (
                        <div className="flex w-full flex-col items-center justify-center gap-3 text-error h-full">
                            <span className="material-symbols-outlined" style={{ fontSize: '28px' }} aria-hidden="true">broken_image</span>
                            <p className="text-sm text-center max-w-sm">This page could not be processed: {activePage.error}</p>
                            <button onClick={retryProcessing} className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90">Retry document</button>
                        </div>
                    ) : null}

                    {editingState && (
                        <WordEditModal
                            initialData={editingState}
                            onSave={handleSaveWord}
                            onClose={() => setEditingState(null)}
                        />
                    )}

                    {/* Floating document toolbar — shown whenever a page is loaded
                        (even an errored one) so page navigation stays available; the
                        draw/zoom controls simply no-op without a rendered viewer. */}
                    {activePage && !isDbLoading && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
                            <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
                            {/* Draw/Pan Tool Toggle */}
                            <div className="flex shrink-0 bg-surface-variant rounded-lg p-1">
                                <button
                                    onClick={() => setActiveTool('draw')}
                                    aria-pressed={activeTool === 'draw'}
                                    className={`flex h-7 items-center gap-1 px-3 rounded-md text-sm transition-colors ${activeTool === 'draw' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                                >
                                    <span className="material-symbols-outlined text-[16px]">draw</span>
                                    Edit
                                </button>
                                <button
                                    onClick={() => setActiveTool('pan')}
                                    aria-pressed={activeTool === 'pan'}
                                    className={`flex h-7 items-center gap-1 px-3 rounded-md text-sm transition-colors ${activeTool === 'pan' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                                >
                                    <span className="material-symbols-outlined text-[16px]">pan_tool</span>
                                    Pan
                                </button>
                            </div>

                            {totalPages > 1 && (
                                /* Page Navigation */
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        aria-label="Previous page"
                                        disabled={activePageIndex === 0}
                                        onClick={() => goToPage(activePageIndex - 1)}
                                        className={iconBtnClass}
                                        type="button"
                                    >
                                        <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                                    </button>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={pageInputValue}
                                        onChange={(e) => setPageInputValue(e.target.value)}
                                        onBlur={commitPageInput}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') { e.currentTarget.blur(); }
                                            else if (e.key === 'Escape') { setPageInputValue((activePageIndex + 1).toString()); e.currentTarget.blur(); }
                                        }}
                                        className="h-8 w-9 text-center text-sm bg-surface-variant text-on-surface tabular-nums rounded-lg shadow-sm transition-colors hover:bg-surface-container-high focus:outline-none focus:ring-2 focus:ring-primary/30 cursor-text"
                                        aria-label="Page number"
                                    />
                                    <span className="text-sm text-on-surface-variant select-none whitespace-nowrap">/ {totalPages}</span>
                                    <button
                                        aria-label="Next page"
                                        disabled={activePageIndex === totalPages - 1}
                                        onClick={() => goToPage(activePageIndex + 1)}
                                        className={iconBtnClass}
                                        type="button"
                                    >
                                        <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                                    </button>
                                </div>
                            )}

                            {/* Zoom Controls */}
                            <div className="flex shrink-0 items-center gap-1">
                                <button
                                    aria-label="Zoom out"
                                    className={iconBtnClass}
                                    onClick={() => viewerRef.current?.zoomTo(viewTransform.scale - 0.25)}
                                    type="button"
                                >
                                    <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 0" }}>zoom_out</span>
                                </button>

                                <input
                                    type="range"
                                    min={minZoom}
                                    max="4"
                                    step="0.05"
                                    value={viewTransform.scale}
                                    onChange={(e) => viewerRef.current?.zoomTo(parseFloat(e.target.value))}
                                    className="hidden w-20 accent-primary cursor-pointer sm:block"
                                    title={`Zoom: ${Math.round(viewTransform.scale * 100)}%`}
                                />

                                <button
                                    aria-label="Zoom in"
                                    className={iconBtnClass}
                                    onClick={() => viewerRef.current?.zoomTo(viewTransform.scale + 0.25)}
                                    type="button"
                                >
                                    <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 0" }}>zoom_in</span>
                                </button>

                                <button
                                    aria-label="Reset view"
                                    className={iconBtnClass}
                                    onClick={() => viewerRef.current?.fitToScreen()}
                                    type="button"
                                    title="Fit to screen"
                                >
                                    <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 0" }}>fit_screen</span>
                                </button>
                            </div>
                            </div>
                        </div>
                    )}
                </div>
            </>

            {/* RIGHT PANE */}
            <>
                {/* pr-12 keeps the toggle clear of the floating theme toggle in AppLayout */}
                <div className="mb-4 flex min-h-[40px] flex-wrap items-center justify-between gap-x-3 gap-y-2 pr-12">
                    <h1 className="font-headline-md text-headline-md text-primary truncate">
                        {outputView === 'raw' ? 'Extracted Text' : 'Formatted Table'}
                    </h1>
                    {activePage && (
                        <div className="flex shrink-0 bg-surface-variant rounded-lg p-1">
                            <button
                                onClick={() => setOutputView('raw')}
                                aria-pressed={outputView === 'raw'}
                                className={`h-7 px-3 rounded-md text-sm transition-colors ${outputView === 'raw' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                Raw Text
                            </button>
                            <button
                                onClick={() => setOutputView('table')}
                                aria-pressed={outputView === 'table'}
                                className={`h-7 px-3 rounded-md text-sm transition-colors ${outputView === 'table' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                Formatted Table
                            </button>
                        </div>
                    )}
                </div>

                <div className="relative flex-1 overflow-hidden rounded-2xl border border-outline-variant bg-surface-bright shadow-sm">
                    <div className="h-full overflow-auto px-8 pt-10 pb-24">
                    {isDbLoading ? (
                        <div className="flex h-full items-center justify-center">Awaiting extraction...</div>
                    ) : !activePage?.words ? (
                        <div className="flex h-full items-center justify-center">No readable text found.</div>
                    ) : outputView === 'raw' ? (
                        <div className="space-y-2 font-body-md text-on-surface leading-relaxed">
                            {generateLinesFromWords(activePage.words, activePage.natural_height).map((line, lineIndex) => (
                                <p key={lineIndex} className="min-h-[1.5rem]">
                                    {line.map((word, wordIndex) => {
                                        const isWordSelected = selectedWordId === word.wordId;
                                        const isWordHovered = highlightedWordId === word.wordId;
                                        return (
                                            <span
                                                key={`${lineIndex}-${word.wordId}`}
                                                ref={isWordSelected ? selectedWordRef : undefined}
                                                className={`mr-2 inline-block cursor-pointer rounded transition-colors ${
                                                    isWordSelected
                                                        ? 'font-bold bg-surface-variant'
                                                        : isWordHovered
                                                            ? 'bg-surface-variant/60'
                                                            : ''
                                                }`}
                                                onMouseEnter={() => setHighlightedWordId(word.wordId)}
                                                onMouseLeave={() => setHighlightedWordId(null)}
                                                onFocus={() => setHighlightedWordId(word.wordId)}
                                                onBlur={() => setHighlightedWordId(null)}
                                                onClick={() => {
                                                    // Don't hijack a drag-to-copy text selection into a word click.
                                                    const sel = window.getSelection();
                                                    if (sel && !sel.isCollapsed) return;
                                                    selectWord(word.wordId);
                                                }}
                                                tabIndex={0}
                                            >
                                                {word.text}
                                                {wordIndex < line.length - 1 ? ' ' : ''}
                                            </span>
                                        );
                                    })}
                                </p>
                            ))}
                        </div>
                    ) : (
                        <div className="w-full">
                            {/* When a table is already shown, surface a failed re-extract or a
                                truncation warning as a banner above it (rather than replacing it). */}
                            {!isExtracting && ((provenanceCells?.length ?? 0) > 0 || !!savedCsv) && (extractionError || truncated) && (
                                <div className={`mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${extractionError ? 'border-error/40 bg-error/5 text-error' : 'border-amber-400 bg-amber-50 text-amber-900'}`}>
                                    <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">{extractionError ? 'error' : 'warning'}</span>
                                    <span className="flex-1">
                                        {extractionError ?? 'The model reached its output limit, so this table may be missing trailing rows. Re-extract if any rows look cut off.'}
                                    </span>
                                    <button onClick={handleFormatTable} className="shrink-0 font-medium underline hover:no-underline">Retry</button>
                                </div>
                            )}
                            {isExtracting ? (
                                /* Streaming progress */
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 text-sm text-on-surface-variant">
                                        <span className="inline-block h-2 w-2 rounded-full bg-primary animate-pulse" />
                                        <span>Generating table...</span>
                                    </div>
                                    {streamingContent && (
                                        <pre className="text-sm text-on-surface font-mono bg-surface-variant rounded p-3 whitespace-pre-wrap wrap-break-word max-h-96 overflow-y-auto">
                                            {streamingContent}
                                        </pre>
                                    )}
                                </div>
                            ) : provenanceCells && provenanceCells.length > 0 ? (
                                /* Provenance-annotated table */
                                <>
                                    <div className="mb-3 flex items-center gap-3 text-xs text-on-surface-variant">
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block h-3 w-3 rounded-sm bg-green-200 border border-green-400"></span>
                                            High confidence
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block h-3 w-3 rounded-sm bg-amber-200 border border-amber-400"></span>
                                            Medium
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block h-3 w-3 rounded-sm bg-red-200 border border-red-400"></span>
                                            Low
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block h-3 w-3 rounded-sm bg-surface-variant border border-outline-variant"></span>
                                            Unverified source
                                        </span>
                                        <span className="ml-auto text-on-surface-variant/60">Click a cell to highlight its source</span>
                                    </div>
                                    <ProvenanceTable
                                        rows={provenanceCells}
                                        onCellClick={handleCellClick}
                                        selectedCell={selectedCell}
                                    />
                                </>
                            ) : savedCsv ? (
                                /* Fallback: plain table for extractions without provenance data */
                                (() => {
                                    const rows = parseCSV(savedCsv);
                                    const headers = rows[0] ?? [];
                                    const dataRows = rows.slice(1);
                                    return rows.length > 1 ? (
                                        <div className="overflow-x-auto">
                                            <table className="w-full border-collapse text-sm">
                                                <thead>
                                                    <tr>
                                                        {headers.map((h, i) => (
                                                            <th key={i} className="border border-outline-variant bg-surface-variant px-3 py-2 text-left font-medium text-on-surface">
                                                                {h}
                                                            </th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {dataRows.map((row, ri) => (
                                                        <tr key={ri} className="even:bg-surface-variant/30">
                                                            {row.map((cell, ci) => (
                                                                <td key={ci} className="border border-outline-variant px-3 py-2 text-on-surface">
                                                                    {cell}
                                                                </td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    ) : (
                                        <pre className="text-sm text-on-surface-variant whitespace-pre-wrap wrap-break-word">{savedCsv}</pre>
                                    );
                                })()
                            ) : (extractionError || llamaError) ? (
                                <div className="flex flex-col h-full items-center justify-center gap-3">
                                    <span className="material-symbols-outlined text-error text-[28px]" aria-hidden="true">error</span>
                                    <p className="text-error text-sm text-center max-w-sm">{extractionError || llamaError}</p>
                                    <button
                                        onClick={handleFormatTable}
                                        className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90"
                                    >
                                        Retry
                                    </button>
                                </div>
                            ) : (
                                <div className="flex h-full items-center justify-center text-on-surface-variant">
                                    Click "Format as Table" to organize the extracted text into rows and columns.
                                </div>
                            )}
                        </div>
                    )}
                    </div>

                    {/* Floating action toolbar */}
                    {activePage && (outputView === 'raw' || !isExtracting) && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
                            <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
                                {outputView === 'raw' && (
                                    <button
                                        onClick={handleFormatTable}
                                        disabled={isExtracting}
                                        className="flex h-9 shrink-0 items-center px-4 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                                    >
                                        {isExtracting ? 'Formatting...' : 'Format as Table'}
                                    </button>
                                )}
                                {outputView === 'table' && !isExtracting && (
                                    <>
                                        <ExportMenu
                                            provenanceCells={provenanceCells}
                                            savedCsv={savedCsv}
                                            fileStem={buildFileStem(sourceFileName, activePageIndex, totalPages)}
                                            openUp
                                        />
                                        <button
                                            onClick={handleFormatTable}
                                            disabled={isExtracting}
                                            className="flex h-9 shrink-0 items-center px-4 text-sm bg-surface-variant text-on-surface-variant rounded-lg hover:bg-surface-container-high disabled:opacity-50 transition-colors"
                                        >
                                            Re-extract
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>
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
