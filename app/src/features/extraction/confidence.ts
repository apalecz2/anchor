import type { OcrWord } from '../ocr/types';
import type {
    CellProvenance,
    TokenLogprob,
    ProvenanceCell,
    AgreementStatus,
    TrustLevel,
} from './types';

type CellRange = { start: number; end: number };

// Walk the raw streamed content and return cell character ranges in the same
// coordinate system as TokenLogprob.charOffset (both relative to the start of
// the raw streamed string).  Code fences are skipped but their characters are
// included in the offset space so logprob offsets stay aligned.
export function parseCSVWithOffsets(raw: string): {
    rows: string[][];
    cellRanges: CellRange[][];
} {
    // Find CSV data bounds — skip opening fence, stop before trailing fence
    const fenceStartMatch = raw.match(/^```[a-z]*\r?\n?/i);
    const contentStart = fenceStartMatch ? fenceStartMatch[0].length : 0;

    const fenceEndMatch = raw.match(/\r?\n?```\s*$/);
    const contentEnd = fenceEndMatch ? raw.length - fenceEndMatch[0].length : raw.length;

    const rows: string[][] = [];
    const cellRanges: CellRange[][] = [];
    let pos = contentStart;

    while (pos < contentEnd) {
        // Skip blank lines between rows
        while (pos < contentEnd && (raw[pos] === '\r' || raw[pos] === '\n')) pos++;
        if (pos >= contentEnd) break;

        const rowValues: string[] = [];
        const rowRanges: CellRange[] = [];
        let inQuotes = false;
        let cellStart = pos;

        while (pos <= contentEnd) {
            if (pos === contentEnd) {
                const cellRaw = raw.slice(cellStart, pos);
                if (cellRaw.trim()) {
                    rowRanges.push({ start: cellStart, end: pos });
                    rowValues.push(unquoteField(cellRaw));
                }
                break;
            }

            const ch = raw[pos];

            if (ch === '"') {
                if (inQuotes && raw[pos + 1] === '"') { pos += 2; continue; }
                inQuotes = !inQuotes;
                pos++;
                continue;
            }

            if (!inQuotes && ch === ',') {
                rowRanges.push({ start: cellStart, end: pos });
                rowValues.push(unquoteField(raw.slice(cellStart, pos)));
                pos++;
                cellStart = pos;
                continue;
            }

            if (!inQuotes && (ch === '\n' || ch === '\r')) {
                rowRanges.push({ start: cellStart, end: pos });
                rowValues.push(unquoteField(raw.slice(cellStart, pos)));
                if (ch === '\r' && raw[pos + 1] === '\n') pos++;
                pos++;
                break;
            }

            pos++;
        }

        if (rowValues.length > 0 && rowValues.some(v => v !== '')) {
            rows.push(rowValues);
            cellRanges.push(rowRanges);
        }
    }

    return { rows, cellRanges };
}

function unquoteField(raw: string): string {
    const t = raw.trim();
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        return t.slice(1, -1).replace(/""/g, '"');
    }
    return t;
}

// Assign each logprob token to the cell whose char range contains its offset.
// Returns tokenIndices[r][c] = list of indices into the logprobs array.
function mapLogprobsToCells(
    logprobs: TokenLogprob[],
    cellRanges: CellRange[][],
): number[][][] {
    const result: number[][][] = cellRanges.map(row => row.map(() => []));

    for (let ti = 0; ti < logprobs.length; ti++) {
        const { charOffset } = logprobs[ti];
        outer: for (let r = 0; r < cellRanges.length; r++) {
            for (let c = 0; c < cellRanges[r].length; c++) {
                const { start, end } = cellRanges[r][c];
                if (charOffset >= start && charOffset < end) {
                    result[r][c].push(ti);
                    break outer;
                }
            }
        }
    }

    return result;
}

const arithmeticMean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export const cellTrust = (
    agreement: AgreementStatus,
    llmMean: number,
    llmMin: number,
    ocrConfidence: number | null,
): TrustLevel => {
    if (agreement === "disagree") return "low";
    if (agreement === "image_only") return llmMean >= 0.85 ? "medium" : "low";
    const blended = 0.4 * llmMean + 0.6 * ((ocrConfidence ?? 0) / 100);
    if (blended >= 0.85 && llmMin >= 0.5) return "high";
    if (blended >= 0.65) return "medium";
    return "low";
};

// Attach per-cell confidence to existing CellProvenance data.
// rawContent is the unmodified streamed output (same coord space as logprob offsets).
export const computeProvenanceCells = (
    cellProvenance: CellProvenance[][],
    logprobs: TokenLogprob[],
    rawContent: string,
    ocrWords: OcrWord[],
): ProvenanceCell[][] => {
    const { cellRanges } = parseCSVWithOffsets(rawContent);
    const tokenIndicesMap = mapLogprobsToCells(logprobs, cellRanges);

    return cellProvenance.map((row, r) =>
        row.map((cell, c): ProvenanceCell => {
            const indices = tokenIndicesMap[r]?.[c] ?? [];
            const tokenLogprobs = indices.map(i => logprobs[i].logprob);

            // Geometric mean of per-token probabilities
            const llmMean = tokenLogprobs.length > 0
                ? Math.exp(arithmeticMean(tokenLogprobs))
                : 0;
            // Minimum per-token probability — catches the "one shaky digit" case
            const llmMin = tokenLogprobs.length > 0
                ? Math.exp(Math.min(...tokenLogprobs))
                : 0;

            const ocr = cell.wordIds.length === 0
                ? null
                : arithmeticMean(cell.wordIds.map(id => ocrWords[id].confidence));

            const agreement: AgreementStatus =
                cell.matchStatus === "unmatched" ? "image_only" : "agree";

            const trust = cellTrust(agreement, llmMean, llmMin, ocr);

            return { ...cell, confidence: { llmMean, llmMin, ocr, agreement, trust } };
        })
    );
};
