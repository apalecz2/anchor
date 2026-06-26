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
// Expects TSV (tab-separated) output from the LLM — tabs cannot appear inside
// academic data values, so no quoting/escaping is needed.
export function parseTSVWithOffsets(raw: string): {
    rows: string[][];
    cellRanges: CellRange[][];
} {
    // Find TSV data bounds — skip opening fence, stop before trailing fence
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
        let cellStart = pos;

        while (pos <= contentEnd) {
            const atEnd = pos === contentEnd;
            const ch = atEnd ? '' : raw[pos];

            if (atEnd || ch === '\n' || ch === '\r') {
                rowRanges.push({ start: cellStart, end: pos });
                rowValues.push(raw.slice(cellStart, pos).trim());
                if (!atEnd) {
                    if (ch === '\r' && pos + 1 < contentEnd && raw[pos + 1] === '\n') pos++;
                    pos++;
                }
                break;
            }

            if (ch === '\t') {
                rowRanges.push({ start: cellStart, end: pos });
                rowValues.push(raw.slice(cellStart, pos).trim());
                pos++;
                cellStart = pos;
                continue;
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

// Assign each logprob token to a cell by maximum character-range overlap.
// Returns tokenIndices[r][c] = list of indices into the logprobs array.
//
// A token spans [charOffset, charOffset + token.length). We credit it to the
// cell its span overlaps most, rather than to whichever cell contains its start
// offset. This matters because LLM tokenizers routinely merge a leading
// delimiter into the following value token (e.g. "\t96" as one token). With
// start-offset mapping that token's offset lands on the tab — a dead zone
// between cells — so the value cell receives no tokens and scores a misleading
// 0% confidence. Overlap mapping attributes "\t96" to the cell it actually
// covers. Pure-delimiter tokens (e.g. a lone "\t") overlap no cell range and
// remain unassigned, as intended.
function mapLogprobsToCells(
    logprobs: TokenLogprob[],
    cellRanges: CellRange[][],
): number[][][] {
    const result: number[][][] = cellRanges.map(row => row.map(() => []));

    for (let ti = 0; ti < logprobs.length; ti++) {
        const tokStart = logprobs[ti].charOffset;
        const tokEnd = tokStart + logprobs[ti].token.length;

        let bestOverlap = 0;
        let bestR = -1;
        let bestC = -1;
        for (let r = 0; r < cellRanges.length; r++) {
            for (let c = 0; c < cellRanges[r].length; c++) {
                const { start, end } = cellRanges[r][c];
                const overlap = Math.min(tokEnd, end) - Math.max(tokStart, start);
                if (overlap > bestOverlap) {
                    bestOverlap = overlap;
                    bestR = r;
                    bestC = c;
                }
            }
        }

        if (bestR !== -1) result[bestR][bestC].push(ti);
    }

    return result;
}

const arithmeticMean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export const cellTrust = (
    agreement: AgreementStatus,
    llmMean: number | null,
    llmMin: number | null,
    ocrConfidence: number | null,
): TrustLevel => {
    if (agreement === "disagree") return "low";

    const ocrNorm = (ocrConfidence ?? 0) / 100;

    if (agreement === "image_only") {
        // No OCR to corroborate. With no LLM signal either, we can't vouch for it.
        if (llmMean == null) return "low";
        return llmMean >= 0.85 ? "medium" : "low";
    }

    // agree: when the LLM gave us no usable value signal (llmMean null), trust the
    // OCR match alone rather than dragging the cell down — a strong OCR agreement is
    // still trustworthy even though we can't read the model's certainty here.
    if (llmMean == null) {
        if (ocrNorm >= 0.85) return "high";
        if (ocrNorm >= 0.65) return "medium";
        return "low";
    }

    const blended = 0.4 * llmMean + 0.6 * ocrNorm;
    if (blended >= 0.85 && (llmMin ?? 0) >= 0.5) return "high";
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
    const { cellRanges } = parseTSVWithOffsets(rawContent);
    const tokenIndicesMap = mapLogprobsToCells(logprobs, cellRanges);

    // wordIds are stable UUIDs — resolve confidence via id, not array position.
    const wordById = new Map(ocrWords.map(w => [w.id, w]));

    return cellProvenance.map((row, r) =>
        row.map((cell, c): ProvenanceCell => {
            const indices = tokenIndicesMap[r]?.[c] ?? [];
            const cellStart = cellRanges[r]?.[c]?.start ?? 0;
            // Exclude two kinds of tokens from the value score:
            //  - boundary-merged tokens, whose start falls in the delimiter gap
            //    before this cell (charOffset < cellStart). These fuse a leading
            //    "\t"/"\n" onto the word, so their probability reflects the model's
            //    formatting/segmentation choice, not value certainty — averaging it
            //    in makes a correct cell read as low confidence.
            //  - tokens that arrived without a logprob (null), which we have no
            //    signal for; treating them as logprob 0 (prob 1.0) would inflate.
            // A cell left with no usable value logprobs scores null ("unscored"),
            // distinct from a genuine low score, so the UI can render it neutral.
            const tokenLogprobs = indices
                .filter(i => logprobs[i].charOffset >= cellStart)
                .map(i => logprobs[i].logprob)
                .filter((lp): lp is number => lp != null);

            // Geometric mean of per-token probabilities
            const llmMean = tokenLogprobs.length > 0
                ? Math.exp(arithmeticMean(tokenLogprobs))
                : null;
            // Minimum per-token probability — catches the "one shaky digit" case
            const llmMin = tokenLogprobs.length > 0
                ? Math.exp(Math.min(...tokenLogprobs))
                : null;

            const ocrConfidences = cell.wordIds
                .map(id => wordById.get(id)?.confidence)
                .filter((c): c is number => c != null);
            const ocr = ocrConfidences.length === 0
                ? null
                : arithmeticMean(ocrConfidences);

            const agreement: AgreementStatus =
                cell.matchStatus === "unmatched" ? "image_only" : "agree";

            // A fuzzy match means OCR and the LLM only roughly agree, so cap
            // certainty by knocking the computed trust down one level.
            const baseTrust = cellTrust(agreement, llmMean, llmMin, ocr);
            const trust: TrustLevel = cell.matchStatus === "fuzzy"
                ? (baseTrust === "high" ? "medium" : "low")
                : baseTrust;

            return { ...cell, confidence: { llmMean, llmMin, ocr, agreement, trust } };
        })
    );
};
