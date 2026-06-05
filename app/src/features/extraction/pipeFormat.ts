import type { OcrWord, BoundingBox } from "../ocr/types";
import type { TokenLogprob } from "../llama/llamaClient";

export type RawCell = { value: string; wordId: number };

export type ValidatedCell = {
    value: string;
    wordId: number | null; // null = image-only or invalid ref
    refStatus: "ok" | "image_only" | "invalid_ref" | "ref_mismatch";
    spanWordIds?: number[]; // set when the value spans multiple adjacent OCR words (§6.3)
};

// Find the last UNescaped pipe — the value/wordId separator.
// A pipe is escaped iff it's preceded by an odd number of backslashes.
export const lastUnescapedPipe = (s: string): number => {
    for (let i = s.length - 1; i >= 0; i--) {
        if (s[i] !== "|") continue;
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
        if (backslashes % 2 === 0) return i;
    }
    return -1;
};

// Reverse the escaping applied to values: \| → |   and   \\ → \
export const unescapeValue = (s: string): string => s.replace(/\\([\\|])/g, "$1");

// Split rows on \n and cells on \t first (the grammar guarantees those never
// appear inside a value), then within each cell find the separator with
// lastUnescapedPipe and unescape. Do NOT use a plain lastIndexOf("|") — a
// value may legitimately end in an escaped pipe \|.
export const parsePipeFormat = (output: string): RawCell[][] =>
    output
        .split("\n")
        .filter(line => line.length > 0)
        .map(line =>
            line.split("\t").map(cellStr => {
                const sep = lastUnescapedPipe(cellStr);
                const value = unescapeValue(cellStr.slice(0, sep));
                const wordId = parseInt(cellStr.slice(sep + 1), 10);
                return { value, wordId };
            })
        );

// The model emits every row including the header as ordinary rows (§2.3).
// Treat the first emitted row as the header; remaining rows are data.
export const splitHeaderAndData = (
    rows: RawCell[][]
): { header: RawCell[]; data: RawCell[][] } => {
    const [header = [], ...data] = rows;
    return { header, data };
};

const csvEncodeCell = (value: string): string =>
    /[,"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

// Reattach the header as the first row and emit valid CSV.
// Pass [header, ...data] — i.e. the full rows array — so the header comes first.
// Accepts any row type that has a string value field (RawCell, ValidatedCell, etc.).
export const rawCellsToCSV = (rows: { value: string }[][]): string =>
    rows.map(row => row.map(cell => csvEncodeCell(cell.value)).join(",")).join("\n");

// Normalize for plausibility comparison: lowercase + strip non-alphanumeric.
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Containment check: either string contains the other after normalization.
// Handles common cases: multi-word values whose OCR word is a subset, OCR
// punctuation differences (e.g. "1,250" vs "1250"), case differences.
const plausible = (cellValue: string, ocrText: string): boolean => {
    const a = normalize(cellValue);
    const b = normalize(ocrText);
    if (!a || !b) return true; // nothing to compare after stripping — can't disprove
    return a === b || a.includes(b) || b.includes(a);
};

// For every wordId that isn't -1: range-check it, then plausibility-check the
// value against the OCR word text. This is not optional — a 4B model emitting
// confident-but-wrong word IDs is the primary correctness risk (§6.2).
export const validateRefs = (rows: RawCell[][], ocrWords: OcrWord[]): ValidatedCell[][] =>
    rows.map(row =>
        row.map((cell): ValidatedCell => {
            if (cell.wordId === -1) {
                return { value: cell.value, wordId: null, refStatus: "image_only" };
            }
            if (cell.wordId < 0 || cell.wordId >= ocrWords.length) {
                return { value: cell.value, wordId: null, refStatus: "invalid_ref" };
            }
            if (!plausible(cell.value, ocrWords[cell.wordId].text)) {
                return { value: cell.value, wordId: cell.wordId, refStatus: "ref_mismatch" };
            }
            return { value: cell.value, wordId: cell.wordId, refStatus: "ok" };
        })
    );

// Inline the same formula used in ocrTransforms so this file has no cross-dependency.
const spanLineThreshold = (imageHeight: number): number => Math.max(2, imageHeight * 0.005);

// Group all word indices into lines (sorted by left within each line).
const groupWordsByLine = (ocrWords: OcrWord[], threshold: number): number[][] => {
    const sorted = ocrWords
        .map((_, i) => i)
        .sort((a, b) => {
            const dy = ocrWords[a].box_coords.top - ocrWords[b].box_coords.top;
            if (Math.abs(dy) > threshold) return dy;
            return ocrWords[a].box_coords.left - ocrWords[b].box_coords.left;
        });

    const lines: number[][] = [];
    let cur: number[] = [sorted[0]];
    let curTop = ocrWords[sorted[0]].box_coords.top;

    for (let i = 1; i < sorted.length; i++) {
        const idx = sorted[i];
        if (Math.abs(ocrWords[idx].box_coords.top - curTop) > threshold) {
            lines.push(cur);
            cur = [idx];
            curTop = ocrWords[idx].box_coords.top;
        } else {
            cur.push(idx);
        }
    }
    lines.push(cur);
    return lines;
};

// When a value covers multiple OCR words (e.g. "John Smith" anchored to word
// "John"), find adjacent right-ward words on the same line whose concatenation
// matches the value and record their IDs in spanWordIds (§6.3).
// Only "ok" cells are expanded; others are returned unchanged.
export const expandSpans = (
    rows: ValidatedCell[][],
    ocrWords: OcrWord[],
    imageHeight: number
): ValidatedCell[][] => {
    if (ocrWords.length === 0) return rows;

    const threshold = spanLineThreshold(imageHeight);
    const lines = groupWordsByLine(ocrWords, threshold);

    // wordId → sorted line it belongs to
    const wordToLine = new Map<number, number[]>();
    for (const line of lines) {
        for (const id of line) wordToLine.set(id, line);
    }

    return rows.map(row =>
        row.map((cell): ValidatedCell => {
            if (cell.refStatus !== "ok" || cell.wordId === null) return cell;

            const line = wordToLine.get(cell.wordId);
            if (!line) return cell;

            const start = line.indexOf(cell.wordId);
            const target = normalize(cell.value);

            for (let end = start; end < line.length; end++) {
                const spanIds = line.slice(start, end + 1);
                const concat = normalize(spanIds.map(id => ocrWords[id].text).join(" "));
                if (concat === target) {
                    return spanIds.length > 1 ? { ...cell, spanWordIds: spanIds } : cell;
                }
                if (concat.length > target.length) break;
            }

            return cell;
        })
    );
};

// ---------------------------------------------------------------------------
// §8.1 — LLM confidence via logprobs
// ---------------------------------------------------------------------------

export type CellLogprobs = {
    llmConfidence: number;    // geometric mean of token probs = exp(mean of logprobs)
    llmMinTokenProb: number;  // minimum single-token probability (catches one shaky digit)
};

type CellValueSpan = { row: number; col: number; start: number; end: number };

// Scan the raw pipe-format string and record the [start, end) char range of
// each cell's VALUE portion (between the cell start and its unescaped pipe).
// `inWordId` suppresses pipe/escape handling while consuming the wordId field.
const buildCellValueSpans = (output: string): CellValueSpan[] => {
    const spans: CellValueSpan[] = [];
    let row = 0;
    let col = 0;
    let cellStart = 0;
    let inWordId = false;
    let i = 0;

    while (i < output.length) {
        const ch = output[i];
        if (ch === "\t") {
            col++;
            cellStart = i + 1;
            inWordId = false;
            i++;
        } else if (ch === "\n") {
            row++;
            col = 0;
            cellStart = i + 1;
            inWordId = false;
            i++;
        } else if (!inWordId && ch === "\\") {
            i += 2; // skip escaped char — backslash + next char are both value content
        } else if (!inWordId && ch === "|") {
            spans.push({ row, col, start: cellStart, end: i });
            inWordId = true;
            i++;
        } else {
            i++;
        }
    }

    return spans;
};

const findSpan = (spans: CellValueSpan[], charOffset: number): CellValueSpan | null => {
    for (const span of spans) {
        if (charOffset >= span.start && charOffset < span.end) return span;
    }
    return null;
};

// Map per-token logprobs to the cell whose value span contains each token's
// charOffset. Pipe, tab, newline, and wordId tokens are naturally excluded
// because their offsets fall outside every value span. (§8.1)
//
// rawOutput must be the untrimmed assembled content string — the same string
// whose character positions match the charOffset values in tokenLogprobs.
export const mapLogprobsToCells = (
    rawOutput: string,
    tokenLogprobs: TokenLogprob[],
    rows: RawCell[][]
): CellLogprobs[][] => {
    const spans = buildCellValueSpans(rawOutput);

    // Accumulate per-cell: running sum of logprobs and running minimum prob
    const acc: { logprobs: number[]; minProb: number }[][] = rows.map(row =>
        row.map(() => ({ logprobs: [], minProb: 1 }))
    );

    for (const { logprob, charOffset } of tokenLogprobs) {
        const span = findSpan(spans, charOffset);
        if (!span) continue;
        if (span.row >= acc.length || span.col >= (acc[span.row]?.length ?? 0)) continue;
        const cell = acc[span.row][span.col];
        cell.logprobs.push(logprob);
        cell.minProb = Math.min(cell.minProb, Math.exp(logprob));
    }

    return acc.map(row =>
        row.map(({ logprobs, minProb }) => ({
            // Geometric mean: exp(arithmetic mean of log-probs)
            llmConfidence: logprobs.length > 0
                ? Math.exp(logprobs.reduce((s, lp) => s + lp, 0) / logprobs.length)
                : 0,
            llmMinTokenProb: logprobs.length > 0 ? minProb : 0,
        }))
    );
};

// ---------------------------------------------------------------------------
// §8.2 — OCR confidence aggregation
// ---------------------------------------------------------------------------

// Mean Tesseract confidence (0–100) across the cell's span words.
// Returns null for image-only cells — there is no OCR measurement, so don't
// fabricate one. The caller should treat null as "no OCR backing this value".
export const aggregateOcrConfidence = (
    rows: ValidatedCell[][],
    ocrWords: OcrWord[]
): (number | null)[][] =>
    rows.map(row =>
        row.map(cell => {
            if (cell.wordId === null) return null;
            const ids = cell.spanWordIds ?? [cell.wordId];
            const sum = ids.reduce((s, id) => s + ocrWords[id].confidence, 0);
            return sum / ids.length;
        })
    );

// ---------------------------------------------------------------------------
// §8.3 — Agreement classification
// §8.4 — cellTrust state machine
// ---------------------------------------------------------------------------

export type Agreement = "agree" | "disagree" | "image_only";
export type TrustLevel = "high" | "medium" | "low";

// All thresholds in one place — tune empirically against a labeled sample (§8.4).
export const TRUST_THRESHOLDS = {
    HIGH_BLENDED: 0.85,        // min blended score for "high" trust
    HIGH_MIN_TOKEN_PROB: 0.5,  // weakest single token allowed in a "high" cell
    MEDIUM_BLENDED: 0.65,      // min blended score for "medium" trust
    IMAGE_ONLY_MEDIUM: 0.85,   // llmConfidence required for "medium" on image-only cells
} as const;

// §8.3 — Whether the LLM value agrees with the OCR word it cited.
// Disagreement is the strongest trust signal: two independent readers differ.
// invalid_ref is treated as image_only — there's no valid OCR word to compare.
export const classifyAgreement = (cell: ValidatedCell, ocrWords: OcrWord[]): Agreement => {
    if (cell.refStatus === "image_only" || cell.refStatus === "invalid_ref") return "image_only";
    if (cell.refStatus === "ref_mismatch") return "disagree";
    // refStatus === "ok": wordId is guaranteed non-null here
    return normalize(cell.value) === normalize(ocrWords[cell.wordId!].text) ? "agree" : "disagree";
};

// §8.4 — State machine: collapses agreement + two confidence signals into a
// display trust level. Don't blend when signals conflict; use the state machine.
export const cellTrust = (
    agreement: Agreement,
    llmConfidence: number,
    llmMinTokenProb: number,
    ocrConfidence: number | null,
): TrustLevel => {
    if (agreement === "disagree") return "low";
    if (agreement === "image_only") {
        return llmConfidence >= TRUST_THRESHOLDS.IMAGE_ONLY_MEDIUM ? "medium" : "low";
    }
    // agree: weighted blend — OCR confidence is a direct legibility measurement,
    // so it gets more weight than LLM logprobs (§8.4).
    const blended = 0.4 * llmConfidence + 0.6 * ((ocrConfidence ?? 0) / 100);
    if (blended >= TRUST_THRESHOLDS.HIGH_BLENDED && llmMinTokenProb >= TRUST_THRESHOLDS.HIGH_MIN_TOKEN_PROB) return "high";
    if (blended >= TRUST_THRESHOLDS.MEDIUM_BLENDED) return "medium";
    return "low";
};

// ---------------------------------------------------------------------------
// §7 — Provenance geometry
// ---------------------------------------------------------------------------

const unionBoxes = (boxes: BoundingBox[]): BoundingBox => {
    const left   = Math.min(...boxes.map(b => b.left));
    const top    = Math.min(...boxes.map(b => b.top));
    const right  = Math.max(...boxes.map(b => b.left + b.width));
    const bottom = Math.max(...boxes.map(b => b.top  + b.height));
    return { left, top, width: right - left, height: bottom - top };
};

// Returns the union bounding box of all OCR words the cell maps to.
// Returns null for image-only cells — nothing to highlight on the image.
export const getCellSourceBox = (cell: ValidatedCell, ocrWords: OcrWord[]): BoundingBox | null => {
    if (cell.wordId === null) return null;
    const ids = cell.spanWordIds ?? [cell.wordId];
    return unionBoxes(ids.map(id => ocrWords[id].box_coords));
};
