import React from 'react';
import DocumentViewer from '../../components/DocumentViewer';
import type { DocumentViewerHandle } from '../../components/DocumentViewer';
import {
    MIN_ZOOM,
    maxZoomFor,
    naturalZoomPercent,
    sliderToZoom,
    steppedZoom,
    zoomToSlider,
} from '../../components/documentZoom';
import Icon from '../../components/Icon';
import { HelpOverlay } from '../../components/HelpOverlay';
import { WordEditModal } from '../../features/extraction/WordEditModal';
import type { DocumentPageResult } from '../../features/extraction/types';
import type { ProcessProgress } from '../../features/extraction/useDocumentExtraction';
import type { BoundingBox } from '../../features/ocr/types';
import { iconBtnClass, sourceToolbarClasses } from './sessionToolbar';
import { SourceHelp } from './SessionHelp';

type EditingState = { box?: BoundingBox | null; id?: string; text?: string } | null;
type OverlayMode = 'all' | 'issues' | 'none';

const OVERLAY_MODES: { value: OverlayMode; label: string; description: string }[] = [
    { value: 'all', label: 'All regions', description: 'Show every detected region, color-coded by confidence' },
    { value: 'issues', label: 'Low confidence only', description: 'Dim high-confidence regions so only uncertain ones stand out' },
    { value: 'none', label: 'No overlay', description: 'Hide the confidence overlay entirely' },
];

// Dropdown for choosing which OCR-confidence regions are drawn on the source
// image. A dropdown (rather than a segmented control) scales to a third
// option without crowding the floating toolbar, and opens upward since this
// toolbar sits at the bottom of the pane.
function OverlayModeMenu({ mode, setMode, tb }: {
    mode: OverlayMode;
    setMode: (mode: OverlayMode) => void;
    tb: ReturnType<typeof sourceToolbarClasses>;
}): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const ref = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const current = OVERLAY_MODES.find(m => m.value === mode) ?? OVERLAY_MODES[0];

    return (
        <div className="relative shrink-0" ref={ref}>
            <button
                onClick={() => setOpen(o => !o)}
                aria-haspopup="true"
                aria-expanded={open}
                aria-label={`Overlay: ${current.label}`}
                title="Choose which OCR-confidence regions are shown on the document"
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-surface-variant ${tb.pad} text-sm text-on-surface transition-colors shadow-sm hover:bg-surface-container-high`}
            >
                <Icon name="layers" size={16} />
                {/* The mode is the useful half of the label, so the "Overlay:"
                    qualifier drops a step before the mode name does. */}
                <span className={`${tb.label} whitespace-nowrap`}>
                    <span className={tb.detail}>Overlay:&nbsp;</span>{current.label}
                </span>
                <Icon name="expand_more" size={14} className="leading-none" />
            </button>

            {open && (
                <div className="absolute bottom-full left-0 z-50 mb-1 min-w-64 rounded-xl border border-outline-variant bg-surface py-1 shadow-lg">
                    {OVERLAY_MODES.map(({ value, label, description }) => (
                        <button
                            key={value}
                            onClick={() => { setMode(value); setOpen(false); }}
                            aria-pressed={value === mode}
                            className="flex w-full items-start gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-surface-variant"
                        >
                            <Icon name="check" size={16} className={`mt-0.5 shrink-0 ${value === mode ? 'text-primary' : 'invisible'}`} />
                            <span>
                                <span className="block font-medium text-on-surface">{label}</span>
                                <span className="block text-xs text-on-surface-variant">{description}</span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

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
    /** Whether that box bounds the value itself or only the region it sits in —
     *  decided by the grounding tier the page was extracted at. */
    highlightPrecision: 'exact' | 'coarse';

    // Tool + viewport. Zoom is relative to the fitted size (1 = the image
    // exactly fits the pane); the viewer clamps it to [MIN_ZOOM, maxZoomFor(fit)].
    activeTool: 'draw' | 'pan';
    setActiveTool: (tool: 'draw' | 'pan') => void;
    zoom: number;
    setZoom: (zoom: number) => void;

    // OCR region overlay: 'all' shows every box, 'issues' dims high-confidence
    // ones to reduce clutter, 'none' hides the overlay entirely.
    overlayMode: OverlayMode;
    setOverlayMode: (mode: OverlayMode) => void;

    // Page navigation
    totalPages: number;
    activePageIndex: number;
    goToPage: (index: number) => void;
    pageInputValue: string;
    setPageInputValue: (value: string) => void;
}

export function SourceDocumentPane(props: SourceDocumentPaneProps): React.ReactElement {
    const {
        isDbLoading, showProcessing, processProgress, processingCancelled, dbError,
        cancelProcessing, retryProcessing,
        fileUrl, activePage, viewerRef,
        addWord, editWord, deleteWord, editingState, setEditingState,
        highlightedWordId, setHighlightedWordId, onWordClick, provenanceHighlightBox,
        highlightPrecision,
        activeTool, setActiveTool, zoom, setZoom,
        overlayMode, setOverlayMode,
        totalPages, activePageIndex, goToPage, pageInputValue, setPageInputValue,
    } = props;

    // A broken session: the page's cached image file is missing (the asset
    // protocol 403s), so the <img> fires onError. Track that here to swap the
    // viewer for a clear message instead of leaving a blank/broken pane.
    const [imageLoadFailed, setImageLoadFailed] = React.useState(false);

    const [helpOpen, setHelpOpen] = React.useState(false);

    // Reported by the viewer, which is the only place that knows the image's
    // natural size and the pane's live size. It sets both the zoom ceiling and
    // the true-size readout — null until the first measurement lands.
    const [fitScale, setFitScale] = React.useState<number | null>(null);
    const maxZoom = maxZoomFor(fitScale);
    const naturalPercent = naturalZoomPercent(zoom, fitScale);

    // Where this toolbar drops its labels. Page-count dependent: the navigator
    // below is only rendered for a multi-page document, and it takes enough of
    // the row to move every threshold (see sourceToolbarClasses).
    const tb = sourceToolbarClasses(totalPages > 1);

    // Reset whenever the source image changes (page switch, retry, or a new
    // session), so a prior failure doesn't stick to a freshly-loaded image.
    React.useEffect(() => {
        setImageLoadFailed(false);
    }, [fileUrl]);

    /**
     * Commit a typed page number, clamped into range.
     *
     * The box is rewritten here rather than left to the effect that resyncs it on
     * `activePageIndex`: a clamped entry often *doesn't* move the page (typing 99
     * while already on the last page, or 0 while on the first), so that effect
     * never fires and the box sits showing a page the document doesn't have —
     * indefinitely, since it also looks unchanged to every later render. Writing
     * the committed value unconditionally makes the box a function of the commit,
     * not of a state change that may not happen.
     */
    const commitPageInput = () => {
        const parsed = parseInt(pageInputValue, 10);
        const target = isNaN(parsed)
            ? activePageIndex
            : Math.min(Math.max(parsed - 1, 0), totalPages - 1);
        setPageInputValue((target + 1).toString());
        if (target !== activePageIndex) goToPage(target);
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
            <div className="mb-4 flex min-h-[40px] items-center justify-between">
                <h2 className="font-headline-md text-headline-md text-primary truncate">Source Document</h2>
                {activePage && (
                    <button
                        onClick={() => setHelpOpen(true)}
                        aria-label="About the source document tools"
                        title="Help"
                        type="button"
                        className={iconBtnClass}
                    >
                        <Icon name="info" size={18} />
                    </button>
                )}
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
                        <p className="text-sm text-center max-w-sm overflow-auto">{dbError}</p>
                        <button onClick={retryProcessing} className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90">Retry</button>
                    </div>
                ) : imageLoadFailed ? (
                    <div className="flex w-full flex-col items-center justify-center gap-3 text-error h-full">
                        <Icon name="broken_image" size={28} />
                        <p className="text-sm text-center max-w-sm overflow-auto">
                            The source image for this page could not be loaded. The file may have been moved or deleted.
                        </p>
                        <button onClick={retryProcessing} className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90">Retry document</button>
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
                        zoom={zoom}
                        onZoomChange={setZoom}
                        onFitScaleChange={setFitScale}
                        provenanceHighlightBox={provenanceHighlightBox}
                        highlightPrecision={highlightPrecision}
                        onLoadError={() => setImageLoadFailed(true)}
                        overlayMode={overlayMode}
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
                                aria-label="Edit"
                                title="Edit — draw, edit and delete text regions"
                                className={`flex h-7 items-center gap-1 rounded-md text-sm transition-colors ${tb.pad} ${activeTool === 'draw' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                <Icon name="draw" size={16} />
                                <span className={tb.label}>Edit</span>
                            </button>
                            <button
                                onClick={() => setActiveTool('pan')}
                                aria-pressed={activeTool === 'pan'}
                                aria-label="Pan"
                                title="Pan — drag to move the document"
                                className={`flex h-7 items-center gap-1 rounded-md text-sm transition-colors ${tb.pad} ${activeTool === 'pan' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                <Icon name="pan_tool" size={16} />
                                <span className={tb.label}>Pan</span>
                            </button>
                        </div>

                        <OverlayModeMenu mode={overlayMode} setMode={setOverlayMode} tb={tb} />

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

                        {/* Zoom Controls — the readout is a percentage of the source
                            image's own pixels, so 100% means "actual size, nothing
                            left to see" rather than "fits the pane". The ceiling is
                            exactly that 100% (see documentZoom.ts), which is why the
                            slider's right-hand end is worth reaching. It's a log
                            track: the range is lopsided (a full-page scan fits at
                            ~23%, so it spans ~12%..100%) and linear travel would bury
                            the fitted view near the left stop. The slider is still the
                            first thing to go on a narrow pane — it only duplicates the
                            −/+ buttons — and the readout outlives it, since nothing
                            else reports the current zoom. */}
                        <div className="flex shrink-0 items-center gap-1">
                            <button
                                aria-label="Zoom out"
                                className={iconBtnClass}
                                disabled={zoom <= MIN_ZOOM}
                                onClick={() => setZoom(steppedZoom(zoom, -1, maxZoom))}
                                type="button"
                            >
                                <Icon name="zoom_out" size={18} fill={0} />
                            </button>

                            <input
                                type="range"
                                min={0}
                                max={1}
                                step="0.001"
                                value={zoomToSlider(zoom, maxZoom)}
                                onChange={(e) => setZoom(sliderToZoom(parseFloat(e.target.value), maxZoom))}
                                className={`w-20 accent-primary cursor-pointer ${tb.detailBlock}`}
                                aria-label="Zoom level"
                            />
                            <span
                                className={`w-10 select-none text-center text-xs tabular-nums text-on-surface-variant ${tb.labelBlock}`}
                                title={naturalPercent !== null ? 'Percentage of the scan’s own resolution — 100% is actual size' : undefined}
                            >
                                {naturalPercent !== null ? `${naturalPercent}%` : '—'}
                            </span>

                            <button
                                aria-label="Zoom in"
                                className={iconBtnClass}
                                disabled={zoom >= maxZoom}
                                onClick={() => setZoom(steppedZoom(zoom, 1, maxZoom))}
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
                    </div>
                )}
            </div>

            {helpOpen && (
                <HelpOverlay title="Source Document" onClose={() => setHelpOpen(false)}>
                    <SourceHelp />
                </HelpOverlay>
            )}
        </>
    );
}
