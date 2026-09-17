import type { OcrWord } from '../ocr/types';
import type {
    CellProvenance,
    TokenLogprob,
    ProvenanceCell,
    AgreementStatus,
    GroundingKind,
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

// The trust ladder: one 0–1 score in, one level out. Every branch below is this same
// ladder over a different score, so the thresholds live in exactly one place.
//
// `canReachHigh` gates the top rung on the LLM's *minimum* per-token probability —
// a cell whose mean looks fine but hides one shaky token is not high-trust. It is a
// caller's decision rather than a null check here, because a branch scoring on the
// grounding source alone has no per-token minimum to consult and must not be capped
// for lacking one.
const ladder = (score: number, canReachHigh: boolean): TrustLevel => {
    if (score >= 0.85 && canReachHigh) return "high";
    if (score >= 0.65) return "medium";
    return "low";
};

/** No token in the value arrived shakier than this, so the top rung is available. */
const noShakyToken = (llmMin: number | null): boolean => (llmMin ?? 0) >= 0.5;

/** No single-source cell may be called high-trust, however certain the model sounds. */
const capAtMedium = (trust: TrustLevel): TrustLevel => (trust === "high" ? "medium" : trust);

export const cellTrust = (
    agreement: AgreementStatus,
    llmMean: number | null,
    llmMin: number | null,
    ocrConfidence: number | null,
): TrustLevel => {
    if (agreement === "disagree") return "low";

    if (agreement === "image_only") {
        // Grounding found nothing matching this value. With no LLM signal either, we
        // can't vouch for it. Deliberately not the ladder: an unmatched value is a
        // signal *against* the cell, so it never reaches the 0.65 rung on its own.
        if (llmMean == null) return "low";
        return llmMean >= 0.85 ? "medium" : "low";
    }

    if (agreement === "self_reported") {
        // One source, by design — a preset with no grounding step. There is nothing to
        // corroborate with, so run the same ladder with that single source standing in
        // for both terms (`0.4·x + 0.6·x` is just `x`) and cap the result. No new
        // thresholds: the cap is the only difference, and it is the honest one.
        if (llmMean == null) return "low";
        return capAtMedium(ladder(llmMean, noShakyToken(llmMin)));
    }

    // `agree`: the structured value was found in the grounded source. Blend the two
    // numeric signals — but only when there are two.
    //
    // Either side can be absent for a reason that is not a defect: the LLM's value may
    // have arrived as a single boundary-merged token (llmMean null), and a grounding
    // source may report no confidence at all (Tesseract does; bands from a model with
    // logprobs disabled would not). In both cases the agreement was established by the
    // *match*; the surviving signal grades it. Feeding a missing term in as zero is
    // what would cap such a cell at 0.4 and render a correctly-matched table entirely
    // red — silently, with no error anywhere.
    if (llmMean == null && ocrConfidence == null) return "low";
    // A strong grounding match is trustworthy even though the model's certainty here
    // is unreadable, so this branch is not gated on a minimum it doesn't have.
    if (llmMean == null) return ladder(ocrConfidence! / 100, true);
    if (ocrConfidence == null) return ladder(llmMean, noShakyToken(llmMin));

    return ladder(0.4 * llmMean + 0.6 * (ocrConfidence / 100), noShakyToken(llmMin));
};

// Attach per-cell confidence to existing CellProvenance data.
// rawContent is the unmodified streamed output (same coord space as logprob offsets).
//
// `grounding` names what located the source text, and decides only which agreement
// axis applies: every tier that locates *something* can corroborate a cell, while
// `none` means the structuring model is vouching for itself. It defaults to `word`,
// the tier every shipped preset uses, so today's scoring is unchanged.
export const computeProvenanceCells = (
    cellProvenance: CellProvenance[][],
    logprobs: TokenLogprob[],
    rawContent: string,
    ocrWords: OcrWord[],
    grounding: GroundingKind = 'word',
): ProvenanceCell[][] => {
    const ungrounded = grounding === 'none';
    const { cellRanges } = parseTSVWithOffsets(rawContent);
    const tokenIndicesMap = mapLogprobsToCells(logprobs, cellRanges);

    // wordIds are stable UUIDs — resolve confidence via id, not array position.
    const wordById = new Map(ocrWords.map(w => [w.id, w]));

    return cellProvenance.map((row, r) =>
        row.map((cell, c): ProvenanceCell => {
            // A blank cell has no value tokens and no matched words to score —
            // its verification is spatial, done by provenance. wordIds on an
            // empty cell are *overlooked* words (unclaimed OCR text found at the
            // cell's location): the source shows text where the model output
            // nothing, a genuine disagreement to surface. A clean empty is
            // agreement — blank output over a blank region — not a low score.
            if (cell.matchStatus === "empty") {
                // Without a grounding source there was no region to check the claim
                // against — `verifyEmptyCellsPass` had nothing to run on. That is
                // unverified, not verified-clean, so it must not inherit the `high`
                // a real spatial check earns. Nor is it `low`: nothing is wrong with
                // it, and painting every blank cell red would bury the ones that are.
                if (ungrounded) {
                    return {
                        ...cell,
                        confidence: {
                            llmMean: null, llmMin: null, ocr: null,
                            agreement: "self_reported", trust: "medium",
                        },
                    };
                }
                const overlooked = cell.wordIds.length > 0;
                return {
                    ...cell,
                    confidence: {
                        llmMean: null,
                        llmMin: null,
                        ocr: null,
                        agreement: overlooked ? "disagree" : "agree",
                        trust: overlooked ? "low" : "high",
                    },
                };
            }

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

            // With no grounding source there is no second opinion to agree or disagree
            // with — every cell is the model's own word. `unmatched` cannot arise there
            // (nothing was matched against), so this is a clean split, not a priority.
            const agreement: AgreementStatus = ungrounded
                ? "self_reported"
                : cell.matchStatus === "unmatched" ? "image_only" : "agree";

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
