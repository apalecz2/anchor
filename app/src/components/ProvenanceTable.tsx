import type { ProvenanceCell, TrustLevel } from '../features/extraction/types';

export type SelectedCell = { rowIndex: number; colIndex: number } | null;

interface ProvenanceTableProps {
    rows: ProvenanceCell[][];
    onCellClick: (cell: ProvenanceCell) => void;
    selectedCell: SelectedCell;
}

const TRUST_BG: Record<TrustLevel, string> = {
    high:   'bg-green-100 hover:bg-green-200',
    medium: 'bg-amber-100 hover:bg-amber-200',
    low:    'bg-red-100 hover:bg-red-200',
};

const TRUST_TEXT: Record<TrustLevel, string> = {
    high:   'text-green-900',
    medium: 'text-amber-900',
    low:    'text-red-900',
};

function cellTooltip(cell: ProvenanceCell): string {
    if (cell.confidence.agreement === 'image_only') {
        return 'No matching OCR word — value read from image only';
    }
    const llmPct = (cell.confidence.llmMean * 100).toFixed(0);
    const ocrPct = cell.confidence.ocr != null ? cell.confidence.ocr.toFixed(0) : 'N/A';
    const prefix = cell.matchStatus === 'fuzzy' ? 'Approximate OCR match — verify value | ' : '';
    return `${prefix}LLM confidence: ${llmPct}% | OCR confidence: ${ocrPct}%`;
}

function trustColor(cell: ProvenanceCell): string {
    return cell.confidence.agreement === 'image_only'
        ? 'bg-surface-variant/60 text-on-surface-variant hover:bg-surface-variant'
        : `${TRUST_BG[cell.confidence.trust]} ${TRUST_TEXT[cell.confidence.trust]}`;
}

function cellClasses(cell: ProvenanceCell, isSelected: boolean): string {
    const base = 'border border-outline-variant px-3 py-2 text-sm cursor-pointer transition-colors';
    const ring = isSelected ? ' ring-2 ring-primary ring-inset' : '';
    return `${base} ${trustColor(cell)}${ring}`;
}

// Header cells carry real provenance/confidence too, so they get the same trust
// colors as data cells (previously they were always flat gray, implying
// "unverified" regardless of actual trust — review M14). A heavier bottom border
// and bolder text keep the header row visually distinct from the data it labels.
function headerClasses(cell: ProvenanceCell, isSelected: boolean): string {
    const base = 'border border-outline-variant border-b-2 border-b-on-surface/30 px-3 py-2 text-left text-sm font-semibold cursor-pointer transition-colors';
    const ring = isSelected ? ' ring-2 ring-primary ring-inset' : '';
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

    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
                <thead>
                    <tr>
                        {headerRow.map((cell, c) => (
                            <th
                                key={c}
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
