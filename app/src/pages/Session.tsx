import React, { useState } from 'react';
import { useParams } from 'react-router';
import DocumentViewer from '../components/DocumentViewer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useDocumentExtraction } from '../features/extraction/useDocumentExtraction';
import { useLlamaChat } from '../features/llama/useLlamaChat';
import { SplitLayout } from '../layouts/SplitLayout';
import { WordEditModal } from '../features/extraction/WordEditModal';
import { generateLinesFromWords } from '../utils/ocrTransforms';
import type { BoundingBox } from '../features/ocr/types';

export default function Session(): React.ReactElement {
    const { id } = useParams<{ id: string }>();

    const {
        extractionResult,
        fileUrl,
        isLoading: isDbLoading,
        error: dbError,
        addWord,
        editWord,
        deleteWord
    } = useDocumentExtraction(id);

    const {
        requestTableFormat,
        messages,
        isLoading: isLlamaLoading
    } = useLlamaChat();

    const [outputView, setOutputView] = useState<'raw' | 'table'>('raw');
    const [highlightedWordId, setHighlightedWordId] = useState<string | null>(null);
    const [editingState, setEditingState] = useState<{ box?: BoundingBox | null, id?: string, text?: string } | null>(null);

    const [activeTool, setActiveTool] = useState<'draw' | 'pan'>('draw');
    const [viewTransform, setViewTransform] = useState({ scale: 1, x: 0, y: 0 });

    const activePage = extractionResult?.pages[0];

    const handleFormatTable = async () => {
        if (!fileUrl || !activePage?.text) return;
        setOutputView('table');
        await requestTableFormat(fileUrl, activePage.text);
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
                            {generateLinesFromWords(activePage.words).map((line, lineIndex) => (
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
                        <div className="prose prose-sm md:prose-base dark:prose-invert max-w-none">
                            {messages.length > 0 ? (
                                <>
                                    {messages.filter(m => m.role === 'assistant').map((msg) => (
                                        <div key={msg.id} className="mb-8">
                                            {msg.content && (
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                    {msg.content}
                                                </ReactMarkdown>
                                            )}
                                        </div>
                                    ))}
                                    {isLlamaLoading && messages[messages.length - 1]?.role === 'user' && (
                                        <div className="animate-pulse flex space-x-4 items-center text-on-surface-variant">
                                            <span>Llama is structuring your data...</span>
                                        </div>
                                    )}
                                </>
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