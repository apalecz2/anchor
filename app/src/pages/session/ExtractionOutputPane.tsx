import React from 'react';
import Icon from '../../components/Icon';
import { OutputCard } from '../../components/OutputCard';
import { CopyButton } from '../../components/CopyButton';
import ProvenanceTable from '../../components/ProvenanceTable';
import type { SelectedCell } from '../../components/ProvenanceTable';
import { ExtractionProgress } from '../../features/extraction/ExtractionProgress';
import { ExportMenu } from '../../features/export/ExportMenu';
import { parseCSV } from '../../features/llama/promptUtils';
import type { ExtractionPhase } from '../../features/llama/useLlamaChat';
import type { DocumentPageResult, ProvenanceCell } from '../../features/extraction/types';
import type { LineWord } from '../../features/extraction/types';
import { HelpIsland } from './sessionToolbar';

interface ExtractionOutputPaneProps {
    // View toggle
    outputView: 'raw' | 'table';
    setOutputView: (view: 'raw' | 'table') => void;

    // Load / page state
    activePage: DocumentPageResult | undefined;
    isDbLoading: boolean;
    showProcessing: boolean;
    processingCancelled: boolean;

    // Raw text view
    rawLines: LineWord[][];
    selectedWordId: string | null;
    highlightedWordId: string | null;
    setHighlightedWordId: (id: string | null) => void;
    selectWord: (wordId: string) => void;
    selectedWordRef: React.RefObject<HTMLSpanElement | null>;
    handleCopyRawText: () => Promise<void> | void;

    // Table extraction progress
    isExtracting: boolean;
    isCancelling: boolean;
    extractionPhase: ExtractionPhase;
    streamingContent: string;
    streamRef: React.RefObject<HTMLPreElement | null>;
    cancelTableFormat: () => void;

    // Table result
    provenanceCells: ProvenanceCell[][] | null;
    selectedCell: SelectedCell;
    handleCellClick: (cell: ProvenanceCell) => void;
    savedCsv: string | null;
    handleCopyTable: () => Promise<void> | void;
    hasTable: boolean;

    // Errors / warnings + actions
    extractionError: string | null;
    llamaError: string | null;
    truncated: boolean;
    contextOverflow: boolean;
    handleFormatTable: (boostTokens?: boolean) => void;

    // Export
    fileStem: string;

    onHelp: () => void;
}

export function ExtractionOutputPane(props: ExtractionOutputPaneProps): React.ReactElement {
    const {
        outputView, setOutputView,
        activePage, isDbLoading, showProcessing, processingCancelled,
        rawLines, selectedWordId, highlightedWordId, setHighlightedWordId, selectWord, selectedWordRef, handleCopyRawText,
        isExtracting, isCancelling, extractionPhase, streamingContent, streamRef, cancelTableFormat,
        provenanceCells, selectedCell, handleCellClick, savedCsv, handleCopyTable, hasTable,
        extractionError, llamaError, truncated, contextOverflow, handleFormatTable,
        fileStem, onHelp,
    } = props;

    // A page with no OCR words can't be formatted (a blank page, or one whose
    // render/OCR errored — the left pane shows that page's error + Retry). Gate the
    // "Format as Table" entry points on this so the button is never a silent no-op
    // (handleFormatTable bails on a page with no words/fileUrl).
    const hasWords = (activePage?.words?.length ?? 0) > 0;

    return (
        <>
            <div className="mb-4 flex min-h-[40px] flex-wrap items-center justify-between gap-x-3 gap-y-2">
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

            {/* No surrounding card here: the output/content (e.g. the AI output
                card) sits directly on the pane. This wrapper only provides the
                scroll area and the positioning context for the floating toolbar. */}
            <div className="relative flex-1 overflow-hidden">
                <div className="h-full overflow-auto pb-24">
                {isDbLoading ? (
                    showProcessing ? (
                        <div className="flex h-full items-center justify-center">Awaiting extraction...</div>
                    ) : null
                ) : processingCancelled ? (
                    // Mirror the source pane's neutral cancelled state rather than
                    // claiming OCR ran and found nothing.
                    <div className="flex h-full items-center justify-center text-on-surface-variant">Processing was cancelled.</div>
                ) : !hasWords ? (
                    <div className="flex h-full items-center justify-center text-on-surface-variant">
                        {activePage?.error
                            ? 'This page could not be processed, so there is nothing to extract.'
                            : 'No readable text found.'}
                    </div>
                ) : outputView === 'raw' ? (
                    <div className="flex h-full flex-col">
                        <div className="mb-4 flex shrink-0 items-start gap-2 rounded-lg border border-outline-variant bg-surface-variant/40 px-3 py-2 text-sm text-on-surface-variant">
                            <Icon name="info" size={18} className="shrink-0" />
                            <span>
                                This is an intermediate result — a quick first-pass extraction that may
                                contain inaccuracies. Continue with
                                <span className="font-medium text-on-surface"> Format as Table </span>
                                to re-extract using AI for a more accurate, structured result.
                            </span>
                        </div>

                        {/* Output card: a bordered surface with a labeled header makes
                            clear this block is the extraction output, and gives the
                            copy action a logical home next to the text it copies. The
                            `fill` keeps the header (and copy action) pinned while the
                            detected text scrolls inside the card. */}
                        <OutputCard
                            icon="notes"
                            title="Detected text"
                            fill
                            bodyClassName="space-y-2 px-5 py-4 font-body-md text-on-surface leading-relaxed"
                            action={<CopyButton onCopy={handleCopyRawText} />}
                        >
                            {rawLines.map((line, lineIndex) => (
                                <p key={lineIndex} className="min-h-[1.5rem]">
                                    {line.map((word, wordIndex) => {
                                        const isWordSelected = selectedWordId === word.wordId;
                                        const isWordHovered = highlightedWordId === word.wordId;
                                        return (
                                            // The inter-word space is rendered as a real text
                                            // node *between* the spans (not inside them): trailing
                                            // whitespace inside an inline-block box gets trimmed
                                            // from a manual cursor selection, so words copied via
                                            // drag-select would run together without it.
                                            <React.Fragment key={`${lineIndex}-${word.wordId}`}>
                                                <span
                                                    ref={isWordSelected ? selectedWordRef : undefined}
                                                    className={`inline-block cursor-pointer rounded px-0.5 transition-colors ${
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
                                                </span>
                                                {wordIndex < line.length - 1 ? ' ' : ''}
                                            </React.Fragment>
                                        );
                                    })}
                                </p>
                            ))}
                        </OutputCard>
                    </div>
                ) : (
                    <div className="flex h-full w-full flex-col">
                        {/* When a table is already shown, surface a failed re-extract or a
                            truncation warning as a banner above it (rather than replacing it). */}
                        {!isExtracting && ((provenanceCells?.length ?? 0) > 0 || !!savedCsv) && (extractionError || truncated || contextOverflow) && (
                            <div className={`mb-3 flex shrink-0 items-start gap-2 rounded-lg border px-3 py-2 text-sm ${extractionError ? 'border-error/40 bg-error/5 text-error' : 'border-amber-400 bg-amber-50 text-amber-900'}`}>
                                <Icon name={extractionError ? 'error' : 'warning'} size={18} className="shrink-0" />
                                <span className="flex-1">
                                    {extractionError
                                        ?? (contextOverflow
                                            ? 'This page is dense enough that it may not fit the model in a single pass, so some rows or columns could be missing. Consider splitting the page if the table looks incomplete.'
                                            : 'The model reached its output limit, so this table may be missing trailing rows. Retrying re-runs with a larger output budget — it uses more memory and takes longer, so proceed with caution.')}
                                </span>
                                <button onClick={() => handleFormatTable(!extractionError && truncated)} className="shrink-0 font-medium underline hover:no-underline">Retry</button>
                            </div>
                        )}
                        {isExtracting ? (
                            /* Live, stage-by-stage progress so the user always sees
                               what's happening — model load, image read, generation.
                               Centered in the pane both axes. */
                            <div className="flex h-full flex-col items-center justify-center gap-5">
                                {/* Dim the in-progress detail once cancelling so the
                                    pending "Cancelling…" state reads as the active one. */}
                                <div className={isCancelling ? 'opacity-40 transition-opacity' : 'transition-opacity'}>
                                    <ExtractionProgress phase={extractionPhase} />
                                </div>
                                {/* Fixed height and reserved for the whole generation
                                    phase so streaming tokens fill a stable box instead of
                                    growing the column and shifting the Cancel button. */}
                                {extractionPhase === 'generating' && !isCancelling && (
                                    <pre ref={streamRef} className="h-72 w-full max-w-2xl text-sm text-on-surface font-mono bg-surface-variant rounded p-3 whitespace-pre-wrap wrap-break-word overflow-y-auto">
                                        {streamingContent}
                                    </pre>
                                )}
                                <button
                                    onClick={cancelTableFormat}
                                    disabled={isCancelling}
                                    className="flex items-center gap-2 rounded-lg border border-outline-variant px-4 py-1 text-sm text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
                                >
                                    {isCancelling && (
                                        <Icon name="progress_activity" size={16} className="animate-spin" />
                                    )}
                                    {isCancelling ? 'Cancelling…' : 'Cancel'}
                                </button>
                            </div>
                        ) : provenanceCells && provenanceCells.length > 0 ? (
                            /* Provenance-annotated table */
                            <OutputCard
                                icon="table"
                                title="AI Output"
                                fill
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
                                    <OutputCard icon="table" title="AI Output" fill action={<CopyButton onCopy={handleCopyTable} />}>
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
                                <Icon name="error" size={28} className="text-error" />
                                <p className="text-error text-sm text-center max-w-sm">{extractionError || llamaError}</p>
                                <button
                                    onClick={() => handleFormatTable()}
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
                                    onClick={() => handleFormatTable()}
                                    disabled={isExtracting}
                                    className="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-primary px-5 text-sm text-on-primary shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50"
                                >
                                    <Icon name="table" size={18} />
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
                        {((outputView === 'raw' && hasWords) || (!isExtracting && hasTable)) && (
                            <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
                                {outputView === 'raw' && (
                                    // Once a table exists, the raw view only navigates to it; the
                                    // (re-)generate action lives solely in the table view.
                                    hasTable ? (
                                        <button
                                            onClick={() => setOutputView('table')}
                                            className="flex h-9 shrink-0 items-center gap-2 px-4 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 transition-colors"
                                        >
                                            <Icon name="table" size={18} />
                                            Go to Table
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => handleFormatTable()}
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
                                            fileStem={fileStem}
                                            openUp
                                        />
                                        <button
                                            onClick={() => handleFormatTable()}
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
                        <HelpIsland onClick={onHelp} label="About the extracted text and table tools" />
                    </div>
                )}
            </div>
        </>
    );
}
