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
import { BoundingBox } from '../features/extraction/types';

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
    const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
    const [editingState, setEditingState] = useState<{ box?: BoundingBox | null, index?: number, text?: string } | null>(null);

    const activePage = extractionResult?.pages[0];

    const handleFormatTable = async () => {
        if (!fileUrl || !activePage?.text) return;
        setOutputView('table');
        await requestTableFormat(fileUrl, activePage.text);
    };

    const handleSaveWord = (text: string) => {
        if (editingState?.index !== undefined) {
            editWord(editingState.index, text);
        } else if (editingState?.box) {
            addWord(text, editingState.box);
        }
        setEditingState(null);
    };


    return (
        <SplitLayout>
            {/* LEFT PANE */}
            <>
                <div className="border-outline-variant p-4">
                    <h2 className="font-headline-sm text-primary text-center">Source Document</h2>
                </div>
                <div className="flex-1 overflow-auto rounded-2xl border border-outline-variant bg-surface-bright px-8 py-10 shadow-sm relative">
                    {isDbLoading ? (
                        <div className="flex w-full items-center justify-center">Processing...</div>
                    ) : dbError ? (
                        <div className="flex w-full items-center justify-center text-error">{dbError}</div>
                    ) : fileUrl && activePage ? (
                        <DocumentViewer
                            fileUrl={fileUrl}
                            words={activePage.words}
                            onAddWord={(box) => setEditingState({ box })}
                            onEditRequest={(index, currentText) => setEditingState({ index, text: currentText })}
                            onDeleteRequest={deleteWord}
                            highlightedIndex={highlightedIndex}
                            setHighlightedIndex={setHighlightedIndex}
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
                <div className="m-2 mb-6 flex items-center justify-between">
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
                                        <span key={`${lineIndex}-${word.originalIndex}`} className="mr-2 inline-block">
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