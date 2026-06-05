import React, { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router';
import DocumentViewer from '../components/DocumentViewer';
import { parseCSV } from '../features/llama/promptUtils';
import { getDb } from '../lib/db';

import { useDocumentExtraction } from '../features/extraction/useDocumentExtraction';
import { useLlamaChat } from '../features/llama/useLlamaChat';
import { LlamaChatProvider } from '../features/llama/LlamaChatContext';
import { SplitLayout } from '../layouts/SplitLayout';
import { WordEditModal } from '../features/extraction/WordEditModal';
import { generateLinesFromWords } from '../utils/ocrTransforms';
import { getCellSourceBox } from '../features/extraction/pipeFormat';
import { ProvenanceRect, CellProvenanceBadge } from '../features/extraction/CellProvenance';
import type { BoundingBox } from '../features/ocr/types';
import type { TrustLevel } from '../features/extraction/pipeFormat';

function SessionContent(): React.ReactElement {
    const { id } = useParams<{ id: string }>();
    const [activePageIndex, setActivePageIndex] = useState(0);

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
        extractionData,
        isExtracting,
        streamingContent,
        clearExtraction,
        serverError: llamaError,
    } = useLlamaChat();

    const [outputView, setOutputView] = useState<'raw' | 'table'>('raw');
    const [savedCsv, setSavedCsv] = useState<string | null>(null);
    const [highlightedWordId, setHighlightedWordId] = useState<string | null>(null);
    const [editingState, setEditingState] = useState<{ box?: BoundingBox | null, id?: string, text?: string } | null>(null);
    const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);

    const [activeTool, setActiveTool] = useState<'draw' | 'pan'>('draw');
    const [viewTransform, setViewTransform] = useState({ scale: 1, x: 0, y: 0 });
    const [pageInputValue, setPageInputValue] = useState('1');

    const totalPages = extractionResult?.pages.length ?? 1;
    const activePage = extractionResult?.pages[activePageIndex];

    useEffect(() => {
        setPageInputValue((activePageIndex + 1).toString());
    }, [activePageIndex]);

    useEffect(() => {
        if (!id) return;
        let cancelled = false;
        async function load() {
            const db = await getDb();
            const rows = await db.select<{ csv_content: string }[]>(
                'SELECT csv_content FROM csv_outputs WHERE session_id = $1 AND page_index = $2',
                [id, activePageIndex]
            );
            if (cancelled) return;
            const csv = rows[0]?.csv_content ?? null;
            setSavedCsv(csv);
            if (csv) setOutputView('table');
        }
        load();
        return () => { cancelled = true; };
    }, [id, activePageIndex]);

    // Keep savedCsv in sync when a fresh extraction completes
    useEffect(() => {
        if (extractionData) setSavedCsv(extractionData.csvString);
    }, [extractionData]);

    const goToPage = (index: number) => {
        setActivePageIndex(index);
        setHighlightedWordId(null);
        setEditingState(null);
        setViewTransform({ scale: 1, x: 0, y: 0 });
        setSelectedCell(null);
        clearExtraction();
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
        await requestTableFormat(fileUrl, activePage.words, activePage.natural_height, id, activePageIndex);
    };

    const trustBg: Record<TrustLevel, string> = {
        high: 'bg-green-50',
        medium: 'bg-yellow-50',
        low: 'bg-red-50',
    };

    const provenanceOverlay = useMemo(() => {
        if (!selectedCell || !extractionData) return undefined;
        const { row, col } = selectedCell;
        const cell = extractionData.validatedRows[row]?.[col];
        if (!cell || cell.wordId === null) return undefined;
        const box = getCellSourceBox(cell, extractionData.sortedWords);
        if (!box) return undefined;
        return <ProvenanceRect box={box} refStatus={cell.refStatus} />;
    }, [selectedCell, extractionData]);

    const handleSaveWord = (text: string) => {
        if (editingState?.id !== undefined) {
            editWord(editingState.id, text);
        } else if (editingState?.box) {
            addWord(text, editingState.box);
        }
        setEditingState(null);
    };


    return (
        <SplitLayout>
            {/* LEFT PANE */}
            <>
                <div className="mb-6 border-outline-variant flex items-center justify-between">
                    <h2 className="font-headline-sm text-primary">Source Document</h2>
                    
                    {fileUrl && activePage && (
                        <div className="flex items-center gap-3">
                            {/* Draw/Pan Tool Toggle */}
                            <div className="flex bg-surface-variant rounded-lg p-1">
                                <button
                                    onClick={() => setActiveTool('draw')}
                                    className={`flex items-center gap-1 px-3 py-1 rounded-md text-sm transition-colors ${activeTool === 'draw' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                                >
                                    <span className="material-symbols-outlined text-[16px]">draw</span>
                                    Edit
                                </button>
                                <button
                                    onClick={() => setActiveTool('pan')}
                                    className={`flex items-center gap-1 px-3 py-1 rounded-md text-sm transition-colors ${activeTool === 'pan' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                                >
                                    <span className="material-symbols-outlined text-[16px]">pan_tool</span>
                                    Pan
                                </button>
                            </div>

                            {totalPages > 1 && (
                                <>
                                    <div className="h-6 w-px bg-outline-variant mx-1"></div>

                                    {/* Page Navigation */}
                                    <div className="flex items-center gap-1">
                                        <button
                                            aria-label="Previous page"
                                            disabled={activePageIndex === 0}
                                            onClick={() => goToPage(activePageIndex - 1)}
                                            className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-variant text-on-surface transition-colors shadow-sm hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
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
                                            className="h-6 w-8 text-center text-sm bg-surface-variant text-on-surface tabular-nums rounded-lg shadow-sm transition-colors hover:bg-surface-container-high focus:outline-none focus:ring-2 focus:ring-primary/30 cursor-text"
                                            aria-label="Page number"
                                        />
                                        <span className="text-sm text-on-surface-variant select-none">/ {totalPages}</span>
                                        <button
                                            aria-label="Next page"
                                            disabled={activePageIndex === totalPages - 1}
                                            onClick={() => goToPage(activePageIndex + 1)}
                                            className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-variant text-on-surface transition-colors shadow-sm hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                                            type="button"
                                        >
                                            <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                                        </button>
                                    </div>
                                </>
                            )}

                            <div className="h-6 w-px bg-outline-variant mx-1"></div>

                            {/* Zoom Controls */}
                            <div className="flex items-center gap-2">
                                <button
                                    aria-label="Zoom out"
                                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-variant text-on-surface transition-colors shadow-sm hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                                    onClick={() => setViewTransform(prev => ({ ...prev, scale: Math.max(0.1, prev.scale - 0.2) }))}
                                    type="button"
                                >
                                    <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 0" }}>zoom_out</span>
                                </button>

                                <input
                                    type="range"
                                    min="0.1"
                                    max="5"
                                    step="0.1"
                                    value={viewTransform.scale}
                                    onChange={(e) => setViewTransform(prev => ({ ...prev, scale: parseFloat(e.target.value) }))}
                                    className="w-20 accent-primary cursor-pointer"
                                    title={`Zoom: ${Math.round(viewTransform.scale * 100)}%`}
                                />

                                <button
                                    aria-label="Zoom in"
                                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-variant text-on-surface transition-colors shadow-sm hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                                    onClick={() => setViewTransform(prev => ({ ...prev, scale: Math.min(10, prev.scale + 0.2) }))}
                                    type="button"
                                >
                                    <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 0" }}>zoom_in</span>
                                </button>

                                <button
                                    aria-label="Reset view"
                                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-variant text-on-surface transition-colors shadow-sm hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 ml-1"
                                    onClick={() => setViewTransform({ scale: 1, x: 0, y: 0 })}
                                    type="button"
                                    title="Reset View"
                                >
                                    <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 0" }}>fit_screen</span>
                                </button>
                            </div>
                        </div>
                    )}
                </div>
                <div className="flex-1 overflow-hidden rounded-2xl border border-outline-variant bg-surface-bright shadow-sm relative">
                    {isDbLoading ? (
                        <div className="flex w-full items-center justify-center h-full">Processing...</div>
                    ) : dbError ? (
                        <div className="flex w-full items-center justify-center text-error h-full">{dbError}</div>
                    ) : fileUrl && activePage ? (
                        <DocumentViewer
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
                            provenanceOverlay={provenanceOverlay}
                        />
                    ) : null}

                    {editingState && (
                        <WordEditModal
                            initialData={editingState}
                            onSave={handleSaveWord}
                            onClose={() => setEditingState(null)}
                        />
                    )}
                </div>
            </>

            {/* RIGHT PANE */}
            <>
                <div className="mb-6 mr-12 h-[40px] flex items-center justify-between">
                    <h1 className="font-headline-sm text-primary">Output</h1>
                    {activePage && (
                        <div className="flex gap-2">
                            <div className="flex bg-surface-variant rounded-lg p-1">
                                <button
                                    onClick={() => setOutputView('raw')}
                                    className={`px-3 py-1 rounded-md text-sm transition-colors ${outputView === 'raw' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                                >
                                    Raw OCR
                                </button>
<button
                                    onClick={() => setOutputView('table')}
                                    className={`px-3 py-1 rounded-md text-sm transition-colors ${outputView === 'table' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                                >
                                    Formatted Table
                                </button>
                            </div>
                            {outputView === 'raw' && (
                                <button
                                    onClick={handleFormatTable}
                                    disabled={isExtracting}
                                    className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 disabled:opacity-50"
                                >
                                    {isExtracting ? 'Extracting...' : 'Format as Table'}
                                </button>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex-1 overflow-auto rounded-2xl border border-outline-variant bg-surface-bright px-8 py-10 shadow-sm">
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
                    ) : isExtracting ? (
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm text-on-surface-variant">
                                <span className="inline-block h-2 w-2 rounded-full bg-primary animate-pulse" />
                                <span>Extracting table...</span>
                            </div>
                            {streamingContent && (
                                <pre className="text-xs text-on-surface-variant font-mono bg-surface-variant rounded p-3 whitespace-pre-wrap max-h-64 overflow-y-auto">
                                    {streamingContent}
                                </pre>
                            )}
                        </div>
                    ) : extractionData ? (
                        // Fresh extraction — show validated table with trust colours and provenance
                        (() => {
                            const headerRow = extractionData.validatedRows[0] ?? [];
                            const dataRows = extractionData.validatedRows.slice(1);
                            return (
                                <div className="overflow-x-auto">
                                    <table className="w-full border-collapse text-sm">
                                        <thead>
                                            <tr>
                                                {headerRow.map((cell, ci) => (
                                                    <th
                                                        key={ci}
                                                        className="border border-outline-variant bg-surface-variant px-3 py-2 text-left font-medium text-on-surface"
                                                    >
                                                        {cell.value}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {dataRows.map((row, ri) => {
                                                const dataRowIndex = ri + 1; // offset for header
                                                return (
                                                    <tr key={ri} className="even:bg-surface-variant/30">
                                                        {row.map((cell, ci) => {
                                                            const trust = extractionData.trustLevels[dataRowIndex]?.[ci];
                                                            const isSelected = selectedCell?.row === dataRowIndex && selectedCell?.col === ci;
                                                            return (
                                                                <td
                                                                    key={ci}
                                                                    onClick={() => setSelectedCell(isSelected ? null : { row: dataRowIndex, col: ci })}
                                                                    className={`border border-outline-variant px-3 py-2 text-on-surface cursor-pointer transition-colors ${trust ? trustBg[trust] : ''} ${isSelected ? 'ring-2 ring-inset ring-primary' : 'hover:bg-surface-variant/50'}`}
                                                                >
                                                                    {cell.value}
                                                                    <CellProvenanceBadge refStatus={cell.refStatus} />
                                                                </td>
                                                            );
                                                        })}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            );
                        })()
                    ) : savedCsv ? (
                        // Reloaded from DB — plain table, no provenance data available
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
                            Click "Format as Table" to extract the table with the local LLM.
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