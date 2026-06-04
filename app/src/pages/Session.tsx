import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router';
import DocumentViewer from '../components/DocumentViewer';
import { parseCSV } from '../features/llama/promptUtils';

import { useDocumentExtraction } from '../features/extraction/useDocumentExtraction';
import { useLlamaChat } from '../features/llama/useLlamaChat';
import { LlamaChatProvider } from '../features/llama/LlamaChatContext';
import { SplitLayout } from '../layouts/SplitLayout';
import { WordEditModal } from '../features/extraction/WordEditModal';
import { generateLinesFromWords, buildTableText } from '../utils/ocrTransforms';
import type { BoundingBox } from '../features/ocr/types';

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
        messages,
        isLoading: isLlamaLoading,
        serverError: llamaError,
    } = useLlamaChat();

    const [outputView, setOutputView] = useState<'raw' | 'table'>('raw');
    const [highlightedWordId, setHighlightedWordId] = useState<string | null>(null);
    const [editingState, setEditingState] = useState<{ box?: BoundingBox | null, id?: string, text?: string } | null>(null);

    const [activeTool, setActiveTool] = useState<'draw' | 'pan'>('draw');
    const [viewTransform, setViewTransform] = useState({ scale: 1, x: 0, y: 0 });
    const [pageInputValue, setPageInputValue] = useState('1');

    const totalPages = extractionResult?.pages.length ?? 1;
    const activePage = extractionResult?.pages[activePageIndex];

    useEffect(() => {
        setPageInputValue((activePageIndex + 1).toString());
    }, [activePageIndex]);

    const goToPage = (index: number) => {
        setActivePageIndex(index);
        setHighlightedWordId(null);
        setEditingState(null);
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
        if (!fileUrl || !activePage?.words.length) return;
        setOutputView('table');
        await requestTableFormat(fileUrl, buildTableText(activePage.words, activePage.natural_height));
    };

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
                            // Pass down new props
                            activeTool={activeTool}
                            transform={viewTransform}
                            setTransform={setViewTransform}
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
                                    disabled={isLlamaLoading}
                                    className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 disabled:opacity-50"
                                >
                                    {isLlamaLoading ? 'Formatting...' : 'Format as Table'}
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
                    ) : (
                        <div className="w-full">
                            {messages.length > 0 ? (
                                messages.filter(m => m.role === 'assistant').map((msg) => {
                                    if (msg.isStreaming) {
                                        const phase = msg.content
                                            ? 'generating'
                                            : msg.thinking
                                            ? 'thinking'
                                            : 'starting';
                                        return (
                                            <div key={msg.id} className="mb-8 space-y-3">
                                                <div className="flex items-center gap-2 text-sm text-on-surface-variant">
                                                    <span className="inline-block h-2 w-2 rounded-full bg-primary animate-pulse" />
                                                    <span>
                                                        {phase === 'thinking' && 'Model is thinking...'}
                                                        {phase === 'generating' && 'Generating CSV...'}
                                                        {phase === 'starting' && 'Starting...'}
                                                    </span>
                                                </div>
                                                {msg.thinking && (
                                                    <details open className="text-xs">
                                                        <summary className="cursor-pointer select-none text-on-surface-variant mb-1">Reasoning (live)</summary>
                                                        <pre className="max-h-48 overflow-y-auto bg-surface-variant rounded p-2 text-on-surface-variant whitespace-pre-wrap wrap-break-word leading-relaxed">
                                                            {msg.thinking}
                                                        </pre>
                                                    </details>
                                                )}
                                                {msg.content && (
                                                    <pre className="text-sm text-on-surface font-mono bg-surface-variant rounded p-3 whitespace-pre-wrap wrap-break-word">
                                                        {msg.content}
                                                    </pre>
                                                )}
                                            </div>
                                        );
                                    }

                                    const rows = msg.content ? parseCSV(msg.content) : [];
                                    const headers = rows[0] ?? [];
                                    const dataRows = rows.slice(1);
                                    return (
                                        <div key={msg.id} className="mb-8 space-y-3">
                                            {msg.thinking && (
                                                <details className="text-xs">
                                                    <summary className="cursor-pointer select-none text-on-surface-variant mb-1">
                                                        Reasoning ({msg.thinking.trim().split(/\s+/).length} words)
                                                    </summary>
                                                    <pre className="max-h-48 overflow-y-auto bg-surface-variant rounded p-2 text-on-surface-variant whitespace-pre-wrap wrap-break-word leading-relaxed">
                                                        {msg.thinking}
                                                    </pre>
                                                </details>
                                            )}
                                            {rows.length > 1 ? (
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
                                                <pre className="text-sm text-on-surface-variant whitespace-pre-wrap wrap-break-word">{msg.content}</pre>
                                            )}
                                        </div>
                                    );
                                })
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
                                    Click "Format as Table" to process the OCR text with the local LLM.
                                </div>
                            )}
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