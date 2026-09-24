import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../../components/Icon';
import { OutputCard } from '../../components/OutputCard';
import { CopyButton } from '../../components/CopyButton';
import { HelpOverlay } from '../../components/HelpOverlay';
import ProvenanceTable, { needsReview } from '../../components/ProvenanceTable';
import type { SelectedCell } from '../../components/ProvenanceTable';
import { ContextMenu } from '../../components/ContextMenu';
import { ExtractionProgress } from '../../features/extraction/ExtractionProgress';
import { ExportMenu } from '../../features/export/ExportMenu';
import { parseCSV } from '../../features/llama/promptUtils';
import type { ExtractionPhase } from '../../features/llama/useLlamaChat';
import type { DocumentPageResult, ProvenanceCell } from '../../features/extraction/types';
import type { LineWord } from '../../features/extraction/types';
import { useTableEditor } from '../../features/extraction/useTableEditor';
import { setEditTarget } from '../../lib/editTarget';
import { flagStepShortcut, formatShortcut, isMacPlatform, redoShortcut } from '../../lib/platform';
import { buildTableMenu } from './tableCommands';
import type { MenuTarget } from './tableCommands';
import { iconBtnClass, viewToggleLabelClass, outputToolbarLabelClass, outputToolbarProseClass, outputToolbarCountClass } from './sessionToolbar';
import { OutputHelp } from './SessionHelp';

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
    rawTextSaved: boolean;

    // Table extraction progress
    isExtracting: boolean;
    isCancelling: boolean;
    extractionPhase: ExtractionPhase;
    currentStepLabel: string | null;
    streamingContent: string;
    streamRef: React.RefObject<HTMLPreElement | null>;
    cancelTableFormat: () => void;

    // Table result
    provenanceCells: ProvenanceCell[][] | null;
    selectedCell: SelectedCell;
    handleCellClick: (cell: ProvenanceCell, opts?: { autoZoom?: boolean }) => void;
    /** Drop the cell selection — clicking off the grid deselects. */
    clearCellSelection: () => void;
    /** Commit an edited grid: updates the session's table state and persists it.
     *  Every table edit — a typed value, a deleted row, an undo — goes through
     *  here as a whole new grid. */
    onApplyGrid: (rows: ProvenanceCell[][]) => void;
    /** Identifies the table being edited (session + page). Changing it clears
     *  the undo history, which belongs to one page's table only. */
    tableKey: string;
    savedCsv: string | null;
    handleCopyTable: () => Promise<void> | void;
    hasTable: boolean;

    // Errors / warnings + actions
    extractionError: string | null;
    truncated: boolean;
    contextOverflow: boolean;
    handleFormatTable: (boostTokens?: boolean) => void;

    // Export
    fileStem: string;
}

// Reflects true save status, not an optimistic one: `saved` only ever flips to
// true once the corresponding DB write has actually completed (see rawTextSaved
// in useDocumentExtraction and the requestTableFormat/DB-load paths in
// Session.tsx, which never populate table state before persisting). While a
// write is in flight the badge shows an explicit "Saving…" state rather than
// disappearing — an absent badge reads as "nothing here", not "not saved yet"
// (review #7). Clicking the saved badge opens a small popover clarifying
// exactly what "saved" means here (on-device, in-app, not yet exported) so it
// isn't mistaken for a cloud sync or an export.
const SAVED_BADGE_POPUP_WIDTH = 256; // matches the popup's w-64
const SAVED_BADGE_POPUP_MARGIN = 8;

function SavedBadge({ saved, subject, note }: { saved: boolean; subject: string; note: string }): React.ReactElement | null {
    const [open, setOpen] = useState(false);
    // Screen-space (not pane-relative) position, so the popup is portaled to
    // <body> and clamped to the viewport instead of being clipped by the
    // OutputCard's `overflow-hidden` when the right-hand pane is narrow —
    // previously the popup's close button could land past the pane's edge
    // and get cut off entirely.
    const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const popupRef = useRef<HTMLDivElement>(null);

    const reposition = () => {
        const rect = buttonRef.current?.getBoundingClientRect();
        if (!rect) return;
        const left = Math.min(rect.left, window.innerWidth - SAVED_BADGE_POPUP_WIDTH - SAVED_BADGE_POPUP_MARGIN);
        setPopupPos({ top: rect.bottom + 4, left: Math.max(left, SAVED_BADGE_POPUP_MARGIN) });
    };

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (buttonRef.current?.contains(target) || popupRef.current?.contains(target)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        window.addEventListener('resize', reposition);
        return () => {
            document.removeEventListener('mousedown', handler);
            window.removeEventListener('resize', reposition);
        };
    }, [open]);

    if (!saved) {
        return (
            <span className="ml-3 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-normal text-on-surface-variant">
                Saving…
                <Icon name="progress_activity" size={14} className="animate-spin" />
            </span>
        );
    }

    return (
        <div className="relative ml-3 shrink-0">
            <button
                ref={buttonRef}
                type="button"
                onClick={() => {
                    reposition();
                    setOpen(o => !o);
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-normal transition-colors hover:bg-green-600/10"
                aria-haspopup="true"
                aria-expanded={open}
            >
                Saved in app
                <Icon name="check_circle" size={14} fill={1} className="text-green-600" />
            </button>

            {open && popupPos && createPortal(
                <div
                    ref={popupRef}
                    style={{ top: popupPos.top, left: popupPos.left }}
                    className="fixed z-50 w-64 rounded-xl border border-outline-variant bg-surface p-3 text-xs leading-relaxed text-on-surface-variant shadow-lg"
                >
                    <button
                        type="button"
                        onClick={() => setOpen(false)}
                        aria-label="Close"
                        className="float-right ml-2 flex h-5 w-5 items-center justify-center rounded text-on-surface-variant/70 transition-colors hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={14} />
                    </button>
                    {subject} is saved locally in the app on this computer, and not to the cloud. You can close this session and come back to it later without re-processing. {note}
                </div>,
                document.body
            )}
        </div>
    );
}

export function ExtractionOutputPane(props: ExtractionOutputPaneProps): React.ReactElement {
    const {
        outputView, setOutputView,
        activePage, isDbLoading, showProcessing, processingCancelled,
        rawLines, selectedWordId, highlightedWordId, setHighlightedWordId, selectWord, selectedWordRef, handleCopyRawText, rawTextSaved,
        isExtracting, isCancelling, extractionPhase, currentStepLabel, streamingContent, streamRef, cancelTableFormat,
        provenanceCells, selectedCell, handleCellClick, clearCellSelection, onApplyGrid, tableKey, savedCsv, handleCopyTable, hasTable,
        extractionError, truncated, contextOverflow, handleFormatTable,
        fileStem,
    } = props;

    // A page with no OCR words can't be formatted (a blank page, or one whose
    // render/OCR errored — the left pane shows that page's error + Retry). Gate the
    // "Format as Table" entry points on this so the button is never a silent no-op
    // (handleFormatTable bails on a page with no words/fileUrl).
    const hasWords = (activePage?.words?.length ?? 0) > 0;

    const [helpOpen, setHelpOpen] = useState(false);

    // On macOS the ⌘Z/⌘A/⌘C/⌘X accelerators belong to the system menu bar, which
    // delivers them through the Edit menu back to this editor via its claim (see
    // menu.rs → runEditMenuCommand → editTarget). The keydown branch below must
    // then leave them alone, or the command would run twice — the same rule
    // TitleBar follows for its own accelerators.
    const [isMac] = useState(() =>
        typeof navigator === 'undefined' ? false : isMacPlatform(navigator.userAgent),
    );

    // Cells worth a second look, in reading order — turns proofreading from a
    // scan of the whole table into a worklist (see the toolbar's review nav).
    // Editing or marking a cell verified resolves it out of the list.
    const flaggedCells = useMemo(
        () => (provenanceCells ?? [])
            .flat()
            .filter(needsReview)
            .sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex),
        [provenanceCells]
    );

    const currentFlagIndex = selectedCell
        ? flaggedCells.findIndex(c => c.rowIndex === selectedCell.rowIndex && c.colIndex === selectedCell.colIndex)
        : -1;

    // Step to the next/previous flagged cell, wrapping around. If the selection
    // isn't itself flagged (typically because it was just resolved), continue
    // from its position in reading order rather than restarting at the first
    // issue — resolve, step, resolve is the core review loop. With no selection
    // at all, start from the first (next) or last (previous) issue.
    const goToFlag = (delta: 1 | -1) => {
        if (flaggedCells.length === 0) return;
        let nextIndex: number;
        if (currentFlagIndex !== -1) {
            nextIndex = (currentFlagIndex + delta + flaggedCells.length) % flaggedCells.length;
        } else if (selectedCell) {
            const after = flaggedCells.findIndex(c =>
                c.rowIndex > selectedCell.rowIndex ||
                (c.rowIndex === selectedCell.rowIndex && c.colIndex > selectedCell.colIndex));
            nextIndex = delta > 0
                ? (after === -1 ? 0 : after)
                : (after === -1 ? flaggedCells.length - 1 : (after - 1 + flaggedCells.length) % flaggedCells.length);
        } else {
            nextIndex = delta > 0 ? 0 : flaggedCells.length - 1;
        }
        handleCellClick(flaggedCells[nextIndex]);
    };

    // Spreadsheet-style editing over the provenance grid: range selection,
    // structural edits, clipboard, undo/redo. It owns no table data — every
    // command hands a whole new grid back through onApplyGrid.
    const editor = useTableEditor({
        rows: provenanceCells,
        selectedCell,
        onApplyGrid,
        onSelectCell: handleCellClick,
        resetKey: tableKey,
    });

    const selectedProvCell = selectedCell
        ? provenanceCells?.[selectedCell.rowIndex]?.[selectedCell.colIndex]
        : undefined;

    // Which surface the open command menu belongs to, and where it hangs. Items
    // are rebuilt on render (not captured when the menu opened) so they always
    // describe the current selection.
    const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget; placement?: 'up' | 'down' } | null>(null);
    const tableMenuButtonRef = useRef<HTMLButtonElement>(null);

    // Keyboard and paste only act on the table while the user is actually
    // working in this pane. The table's cells aren't focusable (they're plain
    // <td>s), so "focus" here means "the last click landed in this pane" —
    // without it, a Delete pressed while editing OCR on the left would silently
    // clear table cells.
    const paneRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<HTMLDivElement>(null);
    const [paneActive, setPaneActive] = useState(false);
    // Registered without a dependency array so each click sees the current
    // editing state and grid (the clear below depends on both).
    useEffect(() => {
        const onPointerDown = (e: MouseEvent) => {
            const node = e.target as HTMLElement | null;
            // The command menu is portalled out of the pane but is part of it,
            // and the window's title bar is chrome rather than another place to
            // be working — reaching for its Edit ▸ Undo must not first take the
            // table's claim on Undo away.
            if (node?.closest?.('[role="menu"], [data-app-titlebar]')) return;
            const insidePane = !!node && !!paneRef.current?.contains(node);
            setPaneActive(insidePane);

            // Clicking off the grid — the card's header or legend, the blank
            // space below the last row, anywhere in the pane that isn't a cell
            // — drops the selection, the way clicking outside a spreadsheet's
            // used range does. Two surfaces are exempt because they *act on*
            // the selection, so deselecting first would disarm the very button
            // being pressed: the floating action toolbar, and (above) the
            // command menu and title-bar Edit menu. An open cell editor is also
            // left alone — that click is the commit, and the committed cell
            // stays selected.
            if (!insidePane || !node || editor.editing) return;
            if (outputView !== 'table' || !provenanceCells?.length) return;
            if (tableRef.current?.contains(node) || node.closest?.('[data-table-actions]')) return;
            clearCellSelection();
            // Every command in the table menus acts on the selection, so one
            // left open over a cleared one is dead UI — all rows disabled, and
            // nothing it can do. Closing here rather than relying on the menu's
            // own outside-click makes the two states move together, and covers
            // the toolbar menu as well as the right-click one (same state).
            setMenu(null);
        };
        document.addEventListener('mousedown', onPointerDown, true);
        return () => document.removeEventListener('mousedown', onPointerDown, true);
    });

    // Claim the title bar's Edit menu while the table is the focused surface.
    // Its undo history is over the grid, its selection is cells rather than
    // text, and it copies TSV — none of which a text field owns or
    // `execCommand` can reach, so with the table focused those menu items would
    // otherwise be dead. Re-registered on every render so the runner never
    // closes over a stale grid (setEditTarget only notifies when the
    // availability changes), and released when the table isn't focused or this
    // pane unmounts, handing the menu back to the focused field.
    const ownsEditMenu = outputView === 'table' && !isExtracting && (provenanceCells?.length ?? 0) > 0 && paneActive;
    useEffect(() => {
        if (!ownsEditMenu) {
            setEditTarget(null);
            return;
        }
        const hasSelection = !!editor.range;
        setEditTarget({
            can: {
                undo: editor.canUndo,
                redo: editor.canRedo,
                cut: hasSelection,
                copy: hasSelection,
                paste: hasSelection,
                selectAll: true,
            },
            run: command => {
                switch (command) {
                    case 'undo': editor.undo(); break;
                    case 'redo': editor.redo(); break;
                    case 'cut': void editor.cutSelection(); break;
                    case 'copy': void editor.copySelection(); break;
                    // No `paste` event to ride on from a menu click, so this one
                    // asks the clipboard directly and says so if that's denied.
                    case 'paste': void editor.pasteFromClipboard(); break;
                    case 'selectAll': editor.selectAll(); break;
                }
            },
        });
    });
    useEffect(() => () => setEditTarget(null), []);

    /**
     * Keyboard model over the table:
     *   ←↑→↓        move the selection one cell; Shift extends the selection.
     *   Alt+←/→, F3 step through the cells still worth reviewing (the toolbar's
     *               chevrons do the same). Plain arrows deliberately no longer
     *               jump between flagged cells — a table you can edit has to let
     *               you walk it cell by cell.
     *   Enter/F2    edit; typing a character replaces the value outright.
     *   Space       mark the selection checked / unchecked.
     *   Delete      clear the selected values.
     *   Ctrl+Z/Y    undo / redo. Ctrl+A/C/X select all / copy / cut.
     * Registered without a dependency array so each keystroke sees the current
     * grid and selection.
     */
    useEffect(() => {
        if (outputView !== 'table' || isExtracting || !provenanceCells?.length || editor.editing) return;

        const handler = (e: KeyboardEvent) => {
            // Never hijack typing in an input/textarea (e.g. the page-number
            // field or the word-edit modal).
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
            if (!paneActive) return;
            // Enter/Space on a focused button must stay the button's activation
            // (e.g. a just-clicked toolbar chevron) — but arrows still navigate.
            const onButton = target?.tagName === 'BUTTON';

            if (e.ctrlKey || e.metaKey) {
                // macOS: the system menu bar owns these and routes them here via
                // the Edit-menu claim, so handling them again would double every
                // one (undo jumping two steps). Off macOS this is their only
                // handler — the webview sees the keystroke first.
                if (isMac) return;
                switch (e.key.toLowerCase()) {
                    case 'z': if (e.shiftKey) editor.redo(); else editor.undo(); break;
                    case 'y': editor.redo(); break;
                    case 'a': editor.selectAll(); break;
                    case 'c': {
                        // A real text selection (drag-highlighted values) is the
                        // user asking for that text, not for the cell range.
                        if (window.getSelection()?.isCollapsed === false) return;
                        void editor.copySelection();
                        break;
                    }
                    case 'x': void editor.cutSelection(); break;
                    default: return;
                }
                e.preventDefault();
                return;
            }

            // Stepping the review worklist: ⌥←/→ on macOS, F3/Shift+F3
            // elsewhere. The split is not cosmetic — off macOS Alt+arrows are
            // the title bar's history nav, and on macOS F3 is a media key. See
            // `flagStepShortcut`.
            const step = flagStepShortcut(e, isMac);
            if (step) {
                goToFlag(step);
                e.preventDefault();
                return;
            }

            switch (e.key) {
                case 'ArrowRight': editor.moveFocus(0, 1, e.shiftKey); break;
                case 'ArrowLeft': editor.moveFocus(0, -1, e.shiftKey); break;
                case 'ArrowDown': editor.moveFocus(1, 0, e.shiftKey); break;
                case 'ArrowUp': editor.moveFocus(-1, 0, e.shiftKey); break;
                case 'Enter':
                case 'F2':
                    if (onButton || !selectedProvCell) return;
                    editor.startEdit();
                    break;
                case ' ':
                    if (onButton || !editor.range) return;
                    editor.commands.toggleVerified();
                    break;
                case 'Delete':
                case 'Backspace':
                    if (!editor.range) return;
                    editor.commands.clear();
                    break;
                default:
                    // Type-over: a printable key replaces the cell's value, the
                    // way it does in a spreadsheet. Only for a single cell — the
                    // typed value has one place to go.
                    if (onButton || e.key.length !== 1 || editor.selectionCount !== 1 || !editor.range) return;
                    editor.typeInto({ rowIndex: editor.range.top, colIndex: editor.range.left }, e.key);
                    break;
            }
            e.preventDefault();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    });

    // Ctrl+V arrives as a paste event carrying the clipboard data, which needs
    // no clipboard-read permission (see useTableEditor.pasteText). On macOS ⌘V
    // instead belongs to the system menu bar, which delivers Paste through the
    // Edit-menu claim (editor.pasteFromClipboard) — riding the native event as
    // well would paste twice, so this path is off there, matching the ⌘-key
    // guard in the keydown handler above.
    useEffect(() => {
        if (isMac || outputView !== 'table' || isExtracting || !provenanceCells?.length || editor.editing || !paneActive) return;
        const handler = (e: ClipboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
            const text = e.clipboardData?.getData('text/plain');
            if (!text) return;
            e.preventDefault();
            editor.pasteText(text);
        };
        window.addEventListener('paste', handler);
        return () => window.removeEventListener('paste', handler);
    });

    return (
        <>
            <div className="mb-4 flex min-h-[40px] flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <h1 className="font-headline-md text-headline-md text-primary truncate">
                    {outputView === 'raw' ? 'Extracted Text' : 'Formatted Table'}
                </h1>
                {activePage && (
                    <div className="flex shrink-0 items-center gap-2">
                        {/* The heading beside this already names the active view, so
                            on a narrow pane the icons carry the toggle on their own
                            rather than squeezing "Formatted Table" against a
                            truncated title. */}
                        <div className="flex shrink-0 bg-surface-variant rounded-lg p-1">
                            <button
                                onClick={() => setOutputView('raw')}
                                aria-pressed={outputView === 'raw'}
                                aria-label="Raw Text"
                                title="Raw Text"
                                className={`flex h-7 items-center gap-1.5 px-2 rounded-md text-sm transition-colors @xl:px-3 ${outputView === 'raw' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                <Icon name="notes" size={16} />
                                <span className={viewToggleLabelClass}>Raw Text</span>
                            </button>
                            <button
                                onClick={() => setOutputView('table')}
                                aria-pressed={outputView === 'table'}
                                aria-label="Formatted Table"
                                title="Formatted Table"
                                className={`flex h-7 items-center gap-1.5 px-2 rounded-md text-sm transition-colors @xl:px-3 ${outputView === 'table' ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                <Icon name="table" size={16} />
                                <span className={viewToggleLabelClass}>Formatted Table</span>
                            </button>
                        </div>
                        <button
                            onClick={() => setHelpOpen(true)}
                            aria-label="About the extracted text and table tools"
                            title="Help"
                            type="button"
                            className={iconBtnClass}
                        >
                            <Icon name="info" size={18} />
                        </button>
                    </div>
                )}
            </div>

            {/* No surrounding card here: the output/content (e.g. the AI output
                card) sits directly on the pane. This wrapper only provides the
                scroll area and the positioning context for the floating toolbar. */}
            <div ref={paneRef} className="relative flex-1 overflow-hidden">
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
                                This is an intermediate result: a quick first-pass extraction that may
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
                            titleBadge={<SavedBadge saved={rawTextSaved} subject="This detected text" note="You can copy it to paste elsewhere." />}
                            fill
                            bodyClassName="space-y-2 px-5 py-4 font-body-md text-on-surface leading-relaxed"
                            action={
                                <div className="flex items-center gap-3">
                                    <span className="hidden items-center gap-1 whitespace-nowrap text-xs text-on-surface-variant @md:flex">
                                        <Icon name="ads_click" size={14} className="shrink-0" />
                                        Click a word to highlight its source
                                    </span>
                                    <CopyButton onCopy={handleCopyRawText} />
                                </div>
                            }
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
                                            : 'The model reached its output limit, so this table may be missing trailing rows. Retrying re-runs with a larger output budget, which uses more memory and takes longer, so proceed with caution.')}
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
                                    <ExtractionProgress phase={extractionPhase} currentStepLabel={currentStepLabel} />
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
                                titleBadge={<SavedBadge saved subject="This formatted table" note="You can export it below." />}
                                fill
                                action={
                                    <div className="flex items-center gap-3">
                                        <span className="hidden items-center gap-1 whitespace-nowrap text-xs text-on-surface-variant @md:flex">
                                            <Icon name="ads_click" size={14} className="shrink-0" />
                                            {editor.selectionCount > 1
                                                ? `${editor.selectionCount} cells selected · right-click to edit the table`
                                                : 'Click a cell to see its source · double-click to edit · right-click for more'}
                                        </span>
                                        <CopyButton onCopy={handleCopyTable} />
                                    </div>
                                }
                                subheader={
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-on-surface-variant">
                                        <span className="flex w-full items-center gap-1.5 text-on-surface-variant">
                                            <Icon name="auto_awesome" size={13} className="shrink-0 text-primary" />
                                            AI-generated: verify against the source before relying on it.
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block h-3 w-3 rounded-sm bg-green-200 border border-green-400"></span>
                                            High confidence
                                        </span>
                                        <span className="hidden h-3 w-px shrink-0 bg-outline-variant @md:block" aria-hidden="true"></span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block h-3 w-3 rounded-sm bg-amber-200 border border-amber-400"></span>
                                            Medium
                                        </span>
                                        <span className="hidden h-3 w-px shrink-0 bg-outline-variant @md:block" aria-hidden="true"></span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block h-3 w-3 rounded-sm bg-red-200 border border-red-400"></span>
                                            <span className="inline-block rounded-full border border-outline-variant bg-surface-variant px-1 text-[10px] font-medium leading-tight">!</span>
                                            Low confidence
                                        </span>
                                        <span className="hidden h-3 w-px shrink-0 bg-outline-variant @md:block" aria-hidden="true"></span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block h-3 w-3 rounded-sm bg-surface-variant border border-outline-variant"></span>
                                            <span className="inline-block rounded-full border border-outline-variant bg-surface-variant px-1 text-[10px] font-medium leading-tight">?</span>
                                            Unverified source
                                        </span>
                                        <span className="hidden h-3 w-px shrink-0 bg-outline-variant @md:block" aria-hidden="true"></span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block rounded-full border border-outline-variant bg-surface-variant px-1 text-[10px] font-medium leading-tight">≈</span>
                                            Approximate match
                                        </span>
                                        <span className="hidden h-3 w-px shrink-0 bg-outline-variant @md:block" aria-hidden="true"></span>
                                        <span className="flex items-center gap-1">
                                            <span className="inline-block rounded-full bg-green-600/15 px-1 text-[10px] font-medium leading-tight text-green-800 dark:text-green-300">✓</span>
                                            Manually verified
                                        </span>
                                    </div>
                                }
                            >
                                {/* Bounds the grid for the click-off-to-deselect
                                    rule above: a mousedown anywhere in the pane
                                    outside this wrapper clears the selection. */}
                                <div ref={tableRef}>
                                    <ProvenanceTable
                                        rows={provenanceCells}
                                        onCellClick={handleCellClick}
                                        selectedCell={selectedCell}
                                        editingCell={editor.editing}
                                        editingInitialValue={editor.editing?.initial}
                                        onStartEdit={cell => editor.startEdit({ rowIndex: cell.rowIndex, colIndex: cell.colIndex })}
                                        onCommitEdit={(cell, value, advance) => editor.commitEdit(cell, value, advance ?? null)}
                                        onCancelEdit={editor.cancelEdit}
                                        selectionRange={editor.range}
                                        onCellPointerDown={(cell, e) => editor.pointerDown(cell, e.shiftKey)}
                                        onCellPointerEnter={editor.pointerEnter}
                                        onCellContextMenu={(cell, e) => {
                                            e.preventDefault();
                                            editor.contextTarget(cell);
                                            setMenu({ x: e.clientX, y: e.clientY, target: 'cell' });
                                        }}
                                        showHandles
                                        onSelectRow={(rowIndex, e) => editor.selectRow(rowIndex, e.shiftKey)}
                                        onSelectColumn={(colIndex, e) => editor.selectColumn(colIndex, e.shiftKey)}
                                        onSelectAll={editor.selectAll}
                                        onHandleContextMenu={({ kind, index }, e) => {
                                            e.preventDefault();
                                            // Keep an existing whole-row/column selection if the
                                            // handle is inside it, so the menu acts on all of it.
                                            if (kind === 'row') {
                                                const covered = editor.range && editor.range.left === 0
                                                    && editor.range.right === editor.gridCols - 1
                                                    && index >= editor.range.top && index <= editor.range.bottom;
                                                if (!covered) editor.selectRow(index);
                                            } else {
                                                const covered = editor.range && editor.range.top === 0
                                                    && editor.range.bottom === editor.gridRows - 1
                                                    && index >= editor.range.left && index <= editor.range.right;
                                                if (!covered) editor.selectColumn(index);
                                            }
                                            setMenu({ x: e.clientX, y: e.clientY, target: kind });
                                        }}
                                    />
                                </div>
                            </OutputCard>
                        ) : savedCsv ? (
                            /* Fallback: plain table for extractions without provenance data */
                            (() => {
                                const parsed = parseCSV(savedCsv);
                                // Pad ragged rows to the widest row: a trailing empty cell
                                // the model omitted (e.g. bottom-right) must still render.
                                const width = parsed.reduce((w, row) => Math.max(w, row.length), 0);
                                const rows = parsed.map(row =>
                                    row.length === width ? row : [...row, ...Array<string>(width - row.length).fill('')]
                                );
                                const headers = rows[0] ?? [];
                                const dataRows = rows.slice(1);
                                return (
                                    <OutputCard icon="table" title="AI Output" titleBadge={<SavedBadge saved subject="This formatted table" note="You can export it below." />} fill action={<CopyButton onCopy={handleCopyTable} />}>
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
                        ) : extractionError ? (
                            <div className="flex flex-col h-full items-center justify-center gap-3">
                                <Icon name="error" size={28} className="text-error" />
                                <p className="text-error text-sm text-center max-w-sm">{extractionError}</p>
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
                            <div data-table-actions className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
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
                                        {(provenanceCells?.length ?? 0) > 0 && (
                                            flaggedCells.length > 0 ? (
                                                <div className="flex shrink-0 items-center gap-1 pr-2 mr-1 border-r border-outline-variant">
                                                    <button
                                                        aria-label="Previous cell to review"
                                                        title={`Previous cell to review (${isMac ? '⌥←' : 'Shift+F3'})`}
                                                        onClick={() => goToFlag(-1)}
                                                        className={iconBtnClass}
                                                        type="button"
                                                    >
                                                        <Icon name="chevron_left" size={18} />
                                                    </button>
                                                    {/* The count is the part that has to survive a
                                                        narrow pane; the wording around it doesn't. */}
                                                    <span
                                                        className="whitespace-nowrap px-1 text-sm text-on-surface-variant"
                                                        title={`${flaggedCells.length} cell${flaggedCells.length === 1 ? '' : 's'} to review`}
                                                    >
                                                        {flaggedCells.length}
                                                        <span className={outputToolbarProseClass}>&nbsp;cell{flaggedCells.length === 1 ? '' : 's'} to review</span>
                                                    </span>
                                                    <button
                                                        aria-label="Next cell to review"
                                                        title={`Next cell to review (${isMac ? '⌥→' : 'F3'})`}
                                                        onClick={() => goToFlag(1)}
                                                        className={iconBtnClass}
                                                        type="button"
                                                    >
                                                        <Icon name="chevron_right" size={18} />
                                                    </button>
                                                </div>
                                            ) : (
                                                // The worklist is empty — every cell is either high
                                                // confidence or manually verified. Say so instead of
                                                // silently dropping the review tools.
                                                <div
                                                    className="flex shrink-0 items-center gap-1.5 pr-3 mr-1 border-r border-outline-variant text-sm text-green-700 dark:text-green-400"
                                                    title="All cells reviewed"
                                                >
                                                    <Icon name="check_circle" size={18} fill={1} />
                                                    <span className={`${outputToolbarProseClass} whitespace-nowrap`}>All cells reviewed</span>
                                                </div>
                                            )
                                        )}
                                        {selectedProvCell && (
                                            <div className="flex shrink-0 items-center gap-1 pr-2 mr-1 border-r border-outline-variant">
                                                {editor.selectionCount > 1 && (
                                                    <span className={`${outputToolbarCountClass} whitespace-nowrap px-1 text-sm text-on-surface-variant`}>
                                                        {editor.selectionCount} selected
                                                    </span>
                                                )}
                                                <button
                                                    aria-label="Edit cell value"
                                                    title="Edit cell value (Enter), or double-click the cell"
                                                    onClick={() => editor.startEdit()}
                                                    disabled={editor.selectionCount !== 1}
                                                    className={iconBtnClass}
                                                    type="button"
                                                >
                                                    <Icon name="edit" size={18} />
                                                </button>
                                                <button
                                                    aria-label={editor.verifiedInRange ? 'Unmark as checked' : 'Mark as checked'}
                                                    title={editor.verifiedInRange
                                                        ? `Unmark ${editor.selectionCount > 1 ? 'these cells' : 'this cell'} as checked (Space)`
                                                        : `Mark ${editor.selectionCount > 1 ? 'these cells' : 'this cell'} as checked (Space)`}
                                                    onClick={editor.commands.toggleVerified}
                                                    className={`${iconBtnClass}${editor.verifiedInRange ? ' text-green-700 dark:text-green-400' : ''}`}
                                                    type="button"
                                                >
                                                    <Icon name={editor.verifiedInRange ? 'check_box' : 'check_box_outline_blank'} size={18} />
                                                </button>
                                            </div>
                                        )}
                                        {(provenanceCells?.length ?? 0) > 0 && (
                                            <div className="flex shrink-0 items-center gap-1 pr-2 mr-1 border-r border-outline-variant">
                                                <button
                                                    aria-label="Undo"
                                                    title={`Undo (${formatShortcut('Ctrl+Z', isMac)})`}
                                                    onClick={editor.undo}
                                                    disabled={!editor.canUndo}
                                                    className={iconBtnClass}
                                                    type="button"
                                                >
                                                    <Icon name="undo" size={18} />
                                                </button>
                                                <button
                                                    aria-label="Redo"
                                                    title={`Redo (${redoShortcut(isMac)})`}
                                                    onClick={editor.redo}
                                                    disabled={!editor.canRedo}
                                                    className={iconBtnClass}
                                                    type="button"
                                                >
                                                    <Icon name="redo" size={18} />
                                                </button>
                                                <button
                                                    ref={tableMenuButtonRef}
                                                    onClick={() => {
                                                        const rect = tableMenuButtonRef.current?.getBoundingClientRect();
                                                        if (!rect) return;
                                                        setMenu(open => open?.target === 'toolbar'
                                                            ? null
                                                            : { x: rect.left, y: rect.top - 6, target: 'toolbar', placement: 'up' });
                                                    }}
                                                    aria-haspopup="menu"
                                                    aria-expanded={menu?.target === 'toolbar'}
                                                    aria-label="Edit table"
                                                    title="Rows, columns and other table edits"
                                                    className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-outline-variant px-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-variant @3xl:px-3"
                                                    type="button"
                                                >
                                                    <Icon name="grid_on" size={16} />
                                                    <span className={outputToolbarLabelClass}>Edit table</span>
                                                    <Icon name="expand_more" size={14} className="leading-none" />
                                                </button>
                                            </div>
                                        )}
                                        <ExportMenu
                                            provenanceCells={provenanceCells}
                                            savedCsv={savedCsv}
                                            fileStem={fileStem}
                                            openUp
                                            variant="primary"
                                            collapsible
                                        />
                                        <button
                                            onClick={() => handleFormatTable()}
                                            disabled={isExtracting}
                                            aria-label="Re-extract"
                                            title="Re-extract this page's table"
                                            className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-sm border border-outline-variant text-on-surface-variant rounded-lg hover:bg-surface-variant disabled:opacity-50 transition-colors @3xl:px-3"
                                        >
                                            <Icon name="refresh" size={18} />
                                            <span className={outputToolbarLabelClass}>Re-extract</span>
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* Transient feedback for actions with no visible result of their
                    own (a denied clipboard read, a tidy-up that found nothing). */}
                {editor.notice && outputView === 'table' && (
                    <div
                        role="status"
                        className="pointer-events-none absolute inset-x-0 bottom-20 z-20 flex justify-center px-4"
                    >
                        <span className="rounded-lg border border-outline-variant bg-surface px-3 py-1.5 text-sm text-on-surface-variant shadow-lg">
                            {editor.notice}
                        </span>
                    </div>
                )}
            </div>

            {menu && provenanceCells && provenanceCells.length > 0 && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    placement={menu.placement}
                    label="Table edits"
                    items={buildTableMenu(editor, menu.target, isMac)}
                    onClose={() => setMenu(null)}
                />
            )}

            {helpOpen && (
                <HelpOverlay title="Extracted Text & Table" onClose={() => setHelpOpen(false)}>
                    <OutputHelp isMac={isMac} />
                </HelpOverlay>
            )}
        </>
    );
}
