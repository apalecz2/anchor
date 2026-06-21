import React from 'react';
import DocumentViewer from '../../components/DocumentViewer';
import type { DocumentViewerHandle } from '../../components/DocumentViewer';
import Icon from '../../components/Icon';
import { WordEditModal } from '../../features/extraction/WordEditModal';
import type { DocumentPageResult } from '../../features/extraction/types';
import type { ProcessProgress } from '../../features/extraction/useDocumentExtraction';
import type { BoundingBox } from '../../features/ocr/types';
import { iconBtnClass, HelpIsland } from './sessionToolbar';

type EditingState = { box?: BoundingBox | null; id?: string; text?: string } | null;

interface SourceDocumentPaneProps {
    // Document processing / load state
    isDbLoading: boolean;
    showProcessing: boolean;
    processProgress: ProcessProgress | null;
    processingCancelled: boolean;
    dbError: string | null;
    cancelProcessing: () => void;
    retryProcessing: () => void;

    // Active page + viewer
    fileUrl: string | null;
    activePage: DocumentPageResult | undefined;
    viewerRef: React.RefObject<DocumentViewerHandle | null>;

    // Word editing
    addWord: (text: string, box: BoundingBox) => void;
    editWord: (id: string, text: string) => void;
    deleteWord: (id: string) => void;
    editingState: EditingState;
    setEditingState: (state: EditingState) => void;

    // Word highlighting / selection (links to the output pane)
    highlightedWordId: string | null;
    setHighlightedWordId: (id: string | null) => void;
    onWordClick: (wordId: string) => void;
    provenanceHighlightBox: BoundingBox | null;

    // Tool + viewport
    activeTool: 'draw' | 'pan';
    setActiveTool: (tool: 'draw' | 'pan') => void;
    viewTransform: { scale: number; x: number; y: number };
    setViewTransform: React.Dispatch<React.SetStateAction<{ scale: number; x: number; y: number }>>;
    minZoom: number;
    setMinZoom: (z: number) => void;

    // Page navigation
    totalPages: number;
    activePageIndex: number;
    goToPage: (index: number) => void;
    pageInputValue: string;
    setPageInputValue: (value: string) => void;

    onHelp: () => void;
}

export function SourceDocumentPane(props: SourceDocumentPaneProps): React.ReactElement {
    const {
        isDbLoading, showProcessing, processProgress, processingCancelled, dbError,
        cancelProcessing, retryProcessing,
        fileUrl, activePage, viewerRef,
        addWord, editWord, deleteWord, editingState, setEditingState,
        highlightedWordId, setHighlightedWordId, onWordClick, provenanceHighlightBox,
        activeTool, setActiveTool, viewTransform, setViewTransform, minZoom, setMinZoom,
        totalPages, activePageIndex, goToPage, pageInputValue, setPageInputValue,
        onHelp,
    } = props;

    const commitPageInput = () => {
        const parsed = parseInt(pageInputValue, 10);
        if (!isNaN(parsed)) {
            goToPage(Math.min(Math.max(parsed - 1, 0), totalPages - 1));
        } else {
            setPageInputValue((activePageIndex + 1).toString());
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

    return (
        <>
            <div className="mb-4 flex min-h-[40px] items-center">
                <h2 className="font-headline-md text-headline-md text-primary truncate">Source Document</h2>
            </div>
            <div className="relative flex-1 overflow-hidden rounded-2xl border border-outline-variant bg-surface-bright shadow-sm">
                {isDbLoading ? (
                    showProcessing ? (
                        <div className="flex w-full flex-col items-center justify-center gap-3 h-full text-on-surface-variant">
                            <Icon name="progress_activity" size={28} className="animate-spin" />
                            <span className="text-sm">
                                {processProgress
                                    ? `Processing page ${processProgress.current} of ${processProgress.total}…`
                                    : 'Processing…'}
                            </span>
                            <button
                                onClick={cancelProcessing}
                                className="mt-1 rounded-lg border border-outline-variant px-4 py-1 text-sm text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
                            >
                                Cancel
                            </button>
                        </div>
                    ) : null
                ) : processingCancelled ? (
                    <div className="flex w-full flex-col items-center justify-center gap-3 text-on-surface-variant h-full">
                        <Icon name="cancel" size={28} />
                        <p className="text-sm text-center max-w-sm">Processing was cancelled.</p>
                        <button onClick={retryProcessing} className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90">Process document</button>
                    </div>
                ) : dbError ? (
                    <div className="flex w-full flex-col items-center justify-center gap-3 text-error h-full">
                        <Icon name="error" size={28} />
                        <p className="text-sm text-center max-w-sm">{dbError}</p>
                        <button onClick={retryProcessing} className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90">Retry</button>
                    </div>
                ) : fileUrl && activePage ? (
                    <DocumentViewer
                        ref={viewerRef}
                        fileUrl={fileUrl}
                        words={activePage.words}
                        onAddWord={(box: BoundingBox) => setEditingState({ box })}
                        onEditRequest={(id: string, currentText: string) => setEditingState({ id, text: currentText })}
                        onDeleteRequest={deleteWord}
                        highlightedWordId={highlightedWordId}
                        setHighlightedWordId={setHighlightedWordId}
                        onWordClick={onWordClick}
                        activeTool={activeTool}
                        transform={viewTransform}
                        setTransform={setViewTransform}
                        onMinScaleChange={setMinZoom}
                        provenanceHighlightBox={provenanceHighlightBox}
                    />
                ) : activePage?.error ? (
                    <div className="flex w-full flex-col items-center justify-center gap-3 text-error h-full">
                        <Icon name="broken_image" size={28} />
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
                    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex flex-wrap justify-center gap-2 px-4">
                        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
                        {/* Draw/Pan Tool Toggle */}
                        <div className="flex shrink-0 bg-surface-variant rounded-lg p-1">
                            <button
                                onClick={() => setActiveTool('draw')}
                                aria-pressed={activeTool === 'draw'}
                                className={`flex h-7 items-center gap-1 px-3 rounded-md text-sm transition-colors ${activeTool === 'draw' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                <Icon name="draw" size={16} />
                                Edit
                            </button>
                            <button
                                onClick={() => setActiveTool('pan')}
                                aria-pressed={activeTool === 'pan'}
                                className={`flex h-7 items-center gap-1 px-3 rounded-md text-sm transition-colors ${activeTool === 'pan' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                <Icon name="pan_tool" size={16} />
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
                                    <Icon name="chevron_left" size={18} />
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
                                    <Icon name="chevron_right" size={18} />
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
                                <Icon name="zoom_out" size={18} fill={0} />
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
                                <Icon name="zoom_in" size={18} fill={0} />
                            </button>

                            <button
                                aria-label="Reset view"
                                className={iconBtnClass}
                                onClick={() => viewerRef.current?.fitToScreen()}
                                type="button"
                                title="Fit to screen"
                            >
                                <Icon name="fit_screen" size={18} fill={0} />
                            </button>
                        </div>
                        </div>

                        {/* Second island: help for the source-document side. */}
                        <HelpIsland onClick={onHelp} label="About the source document tools" />
                    </div>
                )}
            </div>
        </>
    );
}
