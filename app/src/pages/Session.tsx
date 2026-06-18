import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router';
import DocumentViewer from '../components/DocumentViewer';
import type { DocumentViewerHandle } from '../components/DocumentViewer';
import ProvenanceTable from '../components/ProvenanceTable';
import type { SelectedCell } from '../components/ProvenanceTable';
import { parseCSV } from '../features/llama/promptUtils';
import { getDb } from '../lib/db';

import { useDocumentExtraction } from '../features/extraction/useDocumentExtraction';
import { useLlamaChat } from '../features/llama/useLlamaChat';
import type { ExtractionPhase } from '../features/llama/useLlamaChat';
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
import { useDialogA11y } from '../hooks/useDialogA11y';

// Ordered stages shown in the table-extraction progress stepper. The order matches
// the phase transitions in requestTableFormat (useLlamaChat).
const EXTRACTION_STEPS: { key: Exclude<ExtractionPhase, 'idle'>; label: string; hint?: string }[] = [
    { key: 'starting', label: 'Loading AI model', hint: 'First run can take a minute while the model loads into memory.' },
    { key: 'preparing', label: 'Reading page image' },
    { key: 'generating', label: 'Generating table' },
    { key: 'finalizing', label: 'Matching to source & saving' },
];

function ExtractionProgress({ phase }: { phase: ExtractionPhase }): React.ReactElement {
    const currentStep = EXTRACTION_STEPS.findIndex(s => s.key === phase);
    return (
        <ol className="space-y-3">
            {EXTRACTION_STEPS.map((step, i) => {
                const status = i < currentStep ? 'done' : i === currentStep ? 'active' : 'pending';
                return (
                    <li key={step.key} className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                            {status === 'done' ? (
                                <span className="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">check_circle</span>
                            ) : status === 'active' ? (
                                <span className="material-symbols-outlined animate-spin text-[20px] text-primary" aria-hidden="true">progress_activity</span>
                            ) : (
                                <span className="h-3 w-3 rounded-full border-2 border-outline-variant" />
                            )}
                        </span>
                        <div className="flex flex-col">
                            <span className={`text-sm ${
                                status === 'pending'
                                    ? 'text-on-surface-variant/50'
                                    : status === 'active'
                                        ? 'font-medium text-on-surface'
                                        : 'text-on-surface-variant'
                            }`}>
                                {step.label}
                            </span>
                            {status === 'active' && step.hint && (
                                <span className="text-xs text-on-surface-variant/70">{step.hint}</span>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

// A single help tip: a leading icon (mirroring the matching toolbar control) with a
// short title and description.
function HelpItem({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }): React.ReactElement {
    return (
        <div className="flex gap-3">
            <span className="material-symbols-outlined mt-0.5 shrink-0 text-[20px] text-primary" aria-hidden="true">{icon}</span>
            <div>
                <p className="font-medium text-on-surface">{title}</p>
                <p className="text-on-surface-variant">{children}</p>
            </div>
        </div>
    );
}

// Modal help overlay. Covers the viewport (fixed) so it isn't clipped by the panes'
// overflow-hidden; closes on backdrop click or Escape via useDialogA11y.
function HelpOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.ReactElement {
    const dialogRef = useDialogA11y<HTMLDivElement>({ active: true, onClose });
    // Portal to <body>: a `container-type` ancestor (the @container panes) would
    // otherwise become the containing block for this fixed overlay and clip it to
    // one pane instead of the whole window.
    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="presentation"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="help-overlay-title"
                className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-outline-variant bg-surface-bright shadow-xl focus:outline-none"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-outline-variant px-6 py-4">
                    <h2 id="help-overlay-title" className="flex items-center gap-2 text-lg font-bold text-primary">
                        <span className="material-symbols-outlined text-[22px]" aria-hidden="true">info</span>
                        {title}
                    </h2>
                    <button
                        onClick={onClose}
                        aria-label="Close help"
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                    >
                        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
                    </button>
                </div>
                <div className="space-y-4 overflow-y-auto px-6 py-5 text-sm">
                    {children}
                </div>
            </div>
        </div>,
        document.body
    );
}

function SourceHelp(): React.ReactElement {
    return (
        <>
            <p className="text-on-surface-variant">
                This pane shows your source document with the text the app detected (OCR)
                overlaid on the image. Use it to check and correct what was read before
                formatting a table.
            </p>
            <HelpItem icon="draw" title="Edit tool">
                Draw a box over missing text to add a word, or click an existing word's box
                to edit or delete it.
            </HelpItem>
            <HelpItem icon="pan_tool" title="Pan tool">
                Switch to Pan to drag the page around without drawing. You can also scroll
                to pan and pinch/scroll to zoom.
            </HelpItem>
            <HelpItem icon="ads_click" title="Click a word">
                Clicking a detected word highlights it in the Extracted Text pane (and
                vice-versa) so you can line up the image with the text.
            </HelpItem>
            <HelpItem icon="zoom_in" title="Zoom & fit">
                Use the zoom buttons or slider to get a closer look; the fit button resets
                the view to the whole page.
            </HelpItem>
            <HelpItem icon="description" title="Multi-page documents">
                For PDFs, use the page controls to move between pages. Each page is
                processed and formatted independently.
            </HelpItem>
        </>
    );
}

function OutputHelp(): React.ReactElement {
    return (
        <>
            <p className="text-on-surface-variant">
                This pane shows the extracted content two ways: the raw detected text, and a
                structured table the AI builds from it.
            </p>
            <HelpItem icon="notes" title="Raw Text">
                The detected text in reading order. Hover or click a word to highlight it on
                the document image.
            </HelpItem>
            <HelpItem icon="content_copy" title="Copy">
                The Copy button copies all of the extracted text with clean spacing and line
                breaks.
            </HelpItem>
            <HelpItem icon="table" title="Format as Table">
                Sends the page to the local AI model, which organizes the text into rows and
                columns. The first run loads the model and can take a minute.
            </HelpItem>
            <HelpItem icon="ads_click" title="Source highlighting">
                Click any table cell to highlight the words it came from on the document.
                Cell colors show how confident the match is — green (high), amber (medium),
                red (low), and grey for cells with no verified source.
            </HelpItem>
            <HelpItem icon="download" title="Export & re-extract">
                Export the finished table (e.g. CSV), or re-extract if the result looks off
                or a warning says rows may be missing.
            </HelpItem>
        </>
    );
}

// Copy tabular data to the clipboard the way a spreadsheet (or Claude's chat) does:
// TSV as text/plain (pastes into a text editor) plus an HTML <table> (pastes as a real
// grid into Excel / Google Sheets / docs). Cells containing tabs, newlines, or quotes
// are quoted like Excel's TSV so the row/column structure survives a plain-text paste.
async function copyTableToClipboard(rows: string[][]): Promise<void> {
    if (rows.length === 0) return;

    const tsvCell = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const tsv = rows.map(r => r.map(tsvCell).join('\t')).join('\n');

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const [head, ...body] = rows;
    const html =
        '<table>' +
        (head ? `<thead><tr>${head.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : '') +
        `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
        '</table>';

    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
        })]);
    } else {
        // Older webviews without ClipboardItem: TSV-only still pastes cleanly into a grid.
        await navigator.clipboard.writeText(tsv);
    }
}

// Copy action with a transient "Copied" confirmation. `onCopy` does the clipboard
// write (and may throw); the button only shows success when it resolves.
function CopyButton({ onCopy, label = 'Copy' }: { onCopy: () => Promise<void> | void; label?: string }): React.ReactElement {
    const [copied, setCopied] = useState(false);
    const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (resetRef.current) clearTimeout(resetRef.current); }, []);

    const handle = async () => {
        try {
            await onCopy();
            setCopied(true);
            if (resetRef.current) clearTimeout(resetRef.current);
            resetRef.current = setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard unavailable — nothing actionable to surface */
        }
    };

    return (
        <button
            onClick={handle}
            aria-label={copied ? 'Copied to clipboard' : `${label} (copies to clipboard)`}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
            <span className={`material-symbols-outlined text-[18px] ${copied ? 'text-green-600' : ''}`} aria-hidden="true">
                {copied ? 'check' : 'content_copy'}
            </span>
            {copied ? 'Copied' : label}
        </button>
    );
}

// Shared shell for an extraction output (raw text, formatted table): a bordered
// surface with a labeled header and an optional header action, so each output reads
// as a deliberate result rather than loose content on the pane.
function OutputCard({ icon, title, action, subheader, bodyClassName = 'px-5 py-4', children }: {
    icon: string;
    title: string;
    action?: React.ReactNode;
    /** Secondary header content (e.g. a legend), rendered below the title row. */
    subheader?: React.ReactNode;
    bodyClassName?: string;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <div className="overflow-hidden rounded-xl border border-outline-variant">
            <div className="border-b border-outline-variant bg-surface-variant/40">
                <div className="flex items-center justify-between gap-2 px-4 py-2">
                    <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-on-surface-variant">
                        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{icon}</span>
                        <span className="truncate">{title}</span>
                    </div>
                    {action}
                </div>
                {subheader && (
                    <div className="border-t border-outline-variant/60 px-4 py-2">
                        {subheader}
                    </div>
                )}
            </div>
            <div className={bodyClassName}>
                {children}
            </div>
        </div>
    );
}

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
        streamingContent,
        isExtracting,
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
        setContextOverflow(false);

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
            setContextOverflow(result.contextOverflow);
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
                        showProcessing ? (
                            <div className="flex w-full flex-col items-center justify-center gap-3 h-full text-on-surface-variant">
                                <span className="material-symbols-outlined animate-spin" style={{ fontSize: '28px' }}>progress_activity</span>
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
                            <span className="material-symbols-outlined" style={{ fontSize: '28px' }} aria-hidden="true">cancel</span>
                            <p className="text-sm text-center max-w-sm">Processing was cancelled.</p>
                            <button onClick={retryProcessing} className="px-4 py-1 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90">Process document</button>
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
                        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex flex-wrap justify-center gap-2 px-4">
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

                            {/* Second island: help for the source-document side. */}
                            <div className="pointer-events-auto flex items-center rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
                                <button
                                    onClick={() => setHelpOpen('source')}
                                    aria-label="About the source document tools"
                                    title="Help"
                                    type="button"
                                    className={iconBtnClass}
                                >
                                    <span className="material-symbols-outlined text-[18px]">info</span>
                                </button>
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
                    <div className="h-full overflow-auto px-4 pt-6 pb-24 @sm:px-8 @sm:pt-10">
                    {isDbLoading ? (
                        showProcessing ? (
                            <div className="flex h-full items-center justify-center">Awaiting extraction...</div>
                        ) : null
                    ) : !activePage?.words ? (
                        <div className="flex h-full items-center justify-center">No readable text found.</div>
                    ) : outputView === 'raw' ? (
                        <>
                            <div className="mb-4 flex items-start gap-2 rounded-lg border border-outline-variant bg-surface-variant/40 px-3 py-2 text-sm text-on-surface-variant">
                                <span className="material-symbols-outlined shrink-0 text-[18px]" aria-hidden="true">info</span>
                                <span>
                                    This is an intermediate result — a quick first-pass extraction that may
                                    contain inaccuracies. Continue with
                                    <span className="font-medium text-on-surface"> Format as Table </span>
                                    to re-extract using AI for a more accurate, structured result.
                                </span>
                            </div>

                            {/* Output card: a bordered surface with a labeled header makes
                                clear this block is the extraction output, and gives the
                                copy action a logical home next to the text it copies. */}
                            <OutputCard
                                icon="notes"
                                title="Detected text"
                                bodyClassName="space-y-2 px-5 py-4 font-body-md text-on-surface leading-relaxed"
                                action={<CopyButton onCopy={handleCopyRawText} />}
                            >
                                {rawLines.map((line, lineIndex) => (
                                    <p key={lineIndex} className="min-h-[1.5rem]">
                                        {line.map((word, wordIndex) => {
                                            const isWordSelected = selectedWordId === word.wordId;
                                            const isWordHovered = highlightedWordId === word.wordId;
                                            return (
                                                <span
                                                    key={`${lineIndex}-${word.wordId}`}
                                                    ref={isWordSelected ? selectedWordRef : undefined}
                                                    className={`mr-2 inline-block cursor-pointer rounded px-0.5 transition-colors ${
                                                        isWordSelected
                                                            ? 'font-bold bg-surface-variant dark:bg-surface-container-low'
                                                            : isWordHovered
                                                                ? 'bg-surface-variant/80 dark:bg-surface-container-high'
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
                            </OutputCard>
                        </>
                    ) : (
                        <div className="w-full h-full">
                            {/* When a table is already shown, surface a failed re-extract or a
                                truncation warning as a banner above it (rather than replacing it). */}
                            {!isExtracting && ((provenanceCells?.length ?? 0) > 0 || !!savedCsv) && (extractionError || truncated || contextOverflow) && (
                                <div className={`mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${extractionError ? 'border-error/40 bg-error/5 text-error' : 'border-amber-400 bg-amber-50 text-amber-900'}`}>
                                    <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">{extractionError ? 'error' : 'warning'}</span>
                                    <span className="flex-1">
                                        {extractionError
                                            ?? (contextOverflow
                                                ? 'This page is dense enough that it may not fit the model in a single pass, so some rows or columns could be missing. Consider splitting the page if the table looks incomplete.'
                                                : 'The model reached its output limit, so this table may be missing trailing rows. Re-extract if any rows look cut off.')}
                                    </span>
                                    <button onClick={handleFormatTable} className="shrink-0 font-medium underline hover:no-underline">Retry</button>
                                </div>
                            )}
                            {isExtracting ? (
                                /* Live, stage-by-stage progress so the user always sees
                                   what's happening — model load, image read, generation.
                                   Centered in the pane both axes. */
                                <div className="flex h-full flex-col items-center justify-center gap-5">
                                    <ExtractionProgress phase={extractionPhase} />
                                    {streamingContent && (
                                        <pre className="w-full max-w-2xl text-sm text-on-surface font-mono bg-surface-variant rounded p-3 whitespace-pre-wrap wrap-break-word max-h-96 overflow-y-auto">
                                            {streamingContent}
                                        </pre>
                                    )}
                                </div>
                            ) : provenanceCells && provenanceCells.length > 0 ? (
                                /* Provenance-annotated table */
                                <OutputCard
                                    icon="table"
                                    title="AI Output"
                                    action={<CopyButton onCopy={handleCopyTable} />}
                                    subheader={
                                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
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
                                            <span className="ml-auto text-on-surface-variant/60 @md:whitespace-nowrap">Click a cell to highlight its source</span>
                                        </div>
                                    }
                                >
                                    <ProvenanceTable
                                        rows={provenanceCells}
                                        onCellClick={handleCellClick}
                                        selectedCell={selectedCell}
                                    />
                                </OutputCard>
                            ) : savedCsv ? (
                                /* Fallback: plain table for extractions without provenance data */
                                (() => {
                                    const rows = parseCSV(savedCsv);
                                    const headers = rows[0] ?? [];
                                    const dataRows = rows.slice(1);
                                    return (
                                        <OutputCard icon="table" title="AI Output" action={<CopyButton onCopy={handleCopyTable} />}>
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
                                                <pre className="text-sm text-on-surface-variant whitespace-pre-wrap wrap-break-word">{savedCsv}</pre>
                                            )}
                                        </OutputCard>
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
                                <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                                    <p className="max-w-sm text-sm text-on-surface-variant">
                                        Organize the extracted text into rows and columns.
                                    </p>
                                    <button
                                        onClick={handleFormatTable}
                                        disabled={isExtracting}
                                        className="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-primary px-5 text-sm text-on-primary shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50"
                                    >
                                        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">table</span>
                                        {isExtracting ? 'Formatting...' : 'Format as Table'}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    </div>

                    {/* Floating action toolbar. The action island in the table tab only
                        appears once a table exists (before that, the centered "Format as
                        Table" button in the empty state is the sole entry point); the help
                        island sits to its right and is always available. */}
                    {activePage && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex flex-wrap justify-center gap-2 px-4">
                            {(outputView === 'raw' || (!isExtracting && hasTable)) && (
                                <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
                                    {outputView === 'raw' && (
                                        // Once a table exists, the raw view only navigates to it; the
                                        // (re-)generate action lives solely in the table view.
                                        hasTable ? (
                                            <button
                                                onClick={() => setOutputView('table')}
                                                className="flex h-9 shrink-0 items-center gap-2 px-4 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 transition-colors"
                                            >
                                                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">table</span>
                                                Go to Table
                                            </button>
                                        ) : (
                                            <button
                                                onClick={handleFormatTable}
                                                disabled={isExtracting}
                                                className="flex h-9 shrink-0 items-center px-4 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                                            >
                                                {isExtracting ? 'Formatting...' : 'Format as Table'}
                                            </button>
                                        )
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
                            )}

                            {/* Second island: help for the extracted-text / table side. */}
                            <div className="pointer-events-auto flex items-center rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
                                <button
                                    onClick={() => setHelpOpen('output')}
                                    aria-label="About the extracted text and table tools"
                                    title="Help"
                                    type="button"
                                    className={iconBtnClass}
                                >
                                    <span className="material-symbols-outlined text-[18px]">info</span>
                                </button>
                            </div>
                        </div>
                    )}
                </div>

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
