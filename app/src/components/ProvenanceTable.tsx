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
    return `LLM confidence: ${llmPct}% | OCR confidence: ${ocrPct}%`;
}

function cellClasses(cell: ProvenanceCell, isSelected: boolean): string {
    const base = 'border border-outline-variant px-3 py-2 text-sm cursor-pointer transition-colors';
    const color = cell.confidence.agreement === 'image_only'
        ? 'bg-surface-variant/60 text-on-surface-variant hover:bg-surface-variant'
        : `${TRUST_BG[cell.confidence.trust]} ${TRUST_TEXT[cell.confidence.trust]}`;
    const ring = isSelected ? ' ring-2 ring-primary ring-inset' : '';
    return `${base} ${color}${ring}`;
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
                                className={`border border-outline-variant bg-surface-variant px-3 py-2 text-left font-medium text-on-surface cursor-pointer hover:bg-surface-container-high transition-colors${isSelected(0, c) ? ' ring-2 ring-primary ring-inset' : ''}`}
                                onClick={() => onCellClick(cell)}
                                title={cellTooltip(cell)}
                            >
                                {cell.value}
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
                                    {cell.confidence.agreement === 'image_only' && (
                                        <span
                                            className="ml-1 inline-block rounded-full bg-surface-variant px-1 text-[10px] font-medium text-on-surface-variant leading-tight"
                                            title="No OCR match — source unverified"
                                        >
                                            ?
                                        </span>
                                    )}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
