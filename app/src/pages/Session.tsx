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
    const [highlightedWordId, setHighlightedWordId] = useState<string | null>(null);
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
            setProvenanceHighlightBox(null);
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
        setProvenanceHighlightBox(null);

        const result = await requestTableFormat(
            fileUrl,
            activePage.words,
            activePage.natural_height,
            id,
            activePageIndex,
        );

        if (result) {
            setSavedCsv(result.csvContent);
            setProvenanceCells(result.provenanceCells);
        }
    };

    const handleCellClick = (cell: ProvenanceCell) => {
        if (!activePage) return;
        setSelectedCell({ rowIndex: cell.rowIndex, colIndex: cell.colIndex });
        // Compute source bbox on the fly — sanitization is deterministic and cheap
        const sanitized = sanitizeWordsForProvenance(activePage.words, activePage.natural_height);
        const box = getCellSourceBox(cell, sanitized);
        setProvenanceHighlightBox(box);
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
                        <div className="flex w-full items-center justify-center h-full">Processing...</div>
                    ) : dbError ? (
                        <div className="flex w-full items-center justify-center text-error h-full">{dbError}</div>
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
                            activeTool={activeTool}
                            transform={viewTransform}
                            setTransform={setViewTransform}
                            onMinScaleChange={setMinZoom}
                            provenanceHighlightBox={provenanceHighlightBox}
                        />
                    ) : null}

                    {editingState && (
                        <WordEditModal
                            initialData={editingState}
                            onSave={handleSaveWord}
                            onClose={() => setEditingState(null)}
                        />
                    )}

                    {/* Floating document toolbar */}
                    {fileUrl && activePage && (
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
                        <div className="space-y-2 font-body-md text-on-surface leading-relaxed select-none">
                            {generateLinesFromWords(activePage.words, activePage.natural_height).map((line, lineIndex) => (
                                <p key={lineIndex} className="min-h-[1.5rem]">
                                    {line.map((word, wordIndex) => (
                                        <span
                                            key={`${lineIndex}-${word.wordId}`}
                                            className="mr-2 inline-block cursor-pointer"
                                            onMouseEnter={() => setHighlightedWordId(word.wordId)}
                                            onMouseLeave={() => setHighlightedWordId(null)}
                                            onFocus={() => setHighlightedWordId(word.wordId)}
                                            onBlur={() => setHighlightedWordId(null)}
                                            tabIndex={0}
                                        >
                                            {word.text}
                                            {wordIndex < line.length - 1 ? ' ' : ''}
                                        </span>
                                    ))}
                                </p>
                            ))}
                        </div>
                    ) : (
                        <div className="w-full">
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
                            ) : llamaError ? (
                                <div className="flex flex-col h-full items-center justify-center gap-3">
                                    <p className="text-error text-sm text-center max-w-sm">{llamaError}</p>
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
