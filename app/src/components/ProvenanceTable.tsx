import { useEffect, useRef } from 'react';
import type { ProvenanceCell, TrustLevel } from '../features/extraction/types';

export type SelectedCell = { rowIndex: number; colIndex: number } | null;

interface ProvenanceTableProps {
    rows: ProvenanceCell[][];
    onCellClick: (cell: ProvenanceCell) => void;
    selectedCell: SelectedCell;
}

// Light mode uses pale pastels with dark text; dark mode uses a translucent deep
// tint over the dark surface with light text, so cells read as subtle tinted
// rows rather than glaring bright blocks.
const TRUST_BG: Record<TrustLevel, string> = {
    high:   'bg-green-100 hover:bg-green-200 dark:bg-green-500/15 dark:hover:bg-green-500/25',
    medium: 'bg-amber-100 hover:bg-amber-200 dark:bg-amber-500/15 dark:hover:bg-amber-500/25',
    low:    'bg-red-100 hover:bg-red-200 dark:bg-red-500/15 dark:hover:bg-red-500/25',
};

const TRUST_TEXT: Record<TrustLevel, string> = {
    high:   'text-green-900 dark:text-green-200',
    medium: 'text-amber-900 dark:text-amber-200',
    low:    'text-red-900 dark:text-red-200',
};

function cellTooltip(cell: ProvenanceCell): string {
    if (cell.confidence.agreement === 'image_only') {
        return 'No matching OCR word — value read from image only';
    }
    // null llmMean = unscored (value arrived as a single boundary-merged token, so
    // the logprob reflects tokenization, not value certainty) — show it as such
    // rather than a misleading 0%/low number.
    const llmStr = cell.confidence.llmMean != null
        ? `${(cell.confidence.llmMean * 100).toFixed(0)}%`
        : 'not scored';
    const ocrPct = cell.confidence.ocr != null ? `${cell.confidence.ocr.toFixed(0)}%` : 'N/A';
    const prefix = cell.matchStatus === 'fuzzy' ? 'Approximate OCR match — verify value | ' : '';
    return `${prefix}LLM confidence: ${llmStr} | OCR confidence: ${ocrPct}`;
}

function trustColor(cell: ProvenanceCell): string {
    return cell.confidence.agreement === 'image_only'
        ? 'bg-surface-variant/60 text-on-surface-variant hover:bg-surface-variant'
        : `${TRUST_BG[cell.confidence.trust]} ${TRUST_TEXT[cell.confidence.trust]}`;
}

// Black ring on the light cells, white on the dark-mode cells — either way it
// contrasts with the trust background it sits on.
const SELECTION_RING = ' ring-2 ring-black dark:ring-white ring-inset';

function cellClasses(cell: ProvenanceCell, isSelected: boolean): string {
    const base = 'border border-outline-variant px-3 py-2 text-sm cursor-pointer transition-colors';
    const ring = isSelected ? SELECTION_RING : '';
    return `${base} ${trustColor(cell)}${ring}`;
}

// Header cells carry real provenance/confidence too, so they get the same trust
// colors as data cells (previously they were always flat gray, implying
// "unverified" regardless of actual trust — review M14). A heavier bottom border
// and bolder text keep the header row visually distinct from the data it labels.
function headerClasses(cell: ProvenanceCell, isSelected: boolean): string {
    const base = 'border border-outline-variant border-b-2 border-b-on-surface/30 px-3 py-2 text-left text-sm font-semibold cursor-pointer transition-colors';
    const ring = isSelected ? SELECTION_RING : '';
    return `${base} ${trustColor(cell)}${ring}`;
}

// The "?" (no OCR source) and "≈" (approximate match) indicators, shared by header
// and data cells.
function CellBadges({ cell }: { cell: ProvenanceCell }) {
    return (
        <>
            {cell.confidence.agreement === 'image_only' && (
                <span
                    className="ml-1 inline-block rounded-full bg-surface-variant px-1 text-[10px] font-medium text-on-surface-variant leading-tight"
                    title="No OCR match — source unverified"
                >
                    ?
                </span>
            )}
            {cell.matchStatus === 'fuzzy' && (
                <span
                    className="ml-1 inline-block rounded-full bg-surface-variant px-1 text-[10px] font-medium text-on-surface-variant leading-tight"
                    title="Approximate OCR match — value differs slightly from OCR"
                >
                    ≈
                </span>
            )}
        </>
    );
}

export default function ProvenanceTable({ rows, onCellClick, selectedCell }: ProvenanceTableProps) {
    if (rows.length === 0) return null;

    const headerRow = rows[0];
    const dataRows = rows.slice(1);

    const isSelected = (r: number, c: number) =>
        selectedCell?.rowIndex === r && selectedCell?.colIndex === c;

    // Bring the selected cell into view when selection changes — needed when the
    // selection comes from clicking a word on the image (e.g. the cell may be
    // scrolled out of the table's viewport). `nearest` keeps movement minimal so a
    // direct cell click that's already visible doesn't jump.
    const selectedRef = useRef<HTMLTableCellElement | null>(null);
    useEffect(() => {
        selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [selectedCell?.rowIndex, selectedCell?.colIndex]);

    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
                <thead>
                    <tr>
                        {headerRow.map((cell, c) => (
                            <th
                                key={c}
                                ref={isSelected(0, c) ? selectedRef : undefined}
                                className={headerClasses(cell, isSelected(0, c))}
                                onClick={() => onCellClick(cell)}
                                title={cellTooltip(cell)}
                            >
                                <span>{cell.value}</span>
                                <CellBadges cell={cell} />
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {dataRows.map((row, ri) => (
                        <tr key={ri}>
                            {row.map((cell, c) => (
                                <td
                                    key={c}
                                    ref={isSelected(ri + 1, c) ? selectedRef : undefined}
                                    className={cellClasses(cell, isSelected(ri + 1, c))}
                                    onClick={() => onCellClick(cell)}
                                    title={cellTooltip(cell)}
                                >
                                    <span>{cell.value}</span>
                                    <CellBadges cell={cell} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
