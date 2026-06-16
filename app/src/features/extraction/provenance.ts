import type { OcrWord, BoundingBox } from '../ocr/types';
import { sortWords } from '../../utils/ocrTransforms';
import type { CellProvenance } from './types';

export const normalize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Sort words into reading order, strip column-rule pipe glyphs, drop empties.
// Each word keeps its stable `id` (UUID) — that id, not the array position, is
// what CellProvenance.wordIds stores, so a later add/edit/delete that reorders
// the array can't mis-resolve a stored mapping.
// Must be called before matching — the positional walk below is relative to the
// order this produces, but only UUIDs survive into the stored provenance.
// Words whose entire text is pipe glyphs (e.g. OCR misread of "I" as "|") are kept with
// their original text so the LLM can cross-reference the image; they will be unmatched by
// provenance and surface as "image_only" / ? badge rather than silently dropped.
export const sanitizeWordsForProvenance = (words: OcrWord[], naturalHeight: number): OcrWord[] =>
    sortWords(words, naturalHeight)
        .map(w => {
            const stripped = w.text.replace(/^\|+|\|+$/g, "").trim();
            return stripped.length > 0 ? { ...w, text: stripped } : w;
        })
        .filter(w => w.text.length > 0);

const unionBoxes = (boxes: BoundingBox[]): BoundingBox => {
    const left   = Math.min(...boxes.map(b => b.left));
    const top    = Math.min(...boxes.map(b => b.top));
    const right  = Math.max(...boxes.map(b => b.left + b.width));
    const bottom = Math.max(...boxes.map(b => b.top + b.height));
    return { left, top, width: right - left, height: bottom - top };
};

// Returns the union bounding box for a cell's source words, or null if unmatched.
//
// `wordIds` are stable OcrWord UUIDs, resolved against the *current* word array
// at click time. Because they are identities rather than positions, an add/edit
// elsewhere on the page no longer shifts a cell onto the wrong box. If a word a
// cell mapped to was since deleted its id won't resolve — we return null (no
// highlight) rather than a misleading partial box or a throw that blanks the pane.
export const getCellSourceBox = (prov: CellProvenance, ocrWords: OcrWord[]): BoundingBox | null => {
    if (prov.wordIds.length === 0) return null;
    const byId = new Map(ocrWords.map(w => [w.id, w]));
    const boxes: BoundingBox[] = [];
    for (const id of prov.wordIds) {
        const word = byId.get(id);
        if (!word) return null;
        boxes.push(word.box_coords);
    }
    return unionBoxes(boxes);
};

// Bounded lookahead window — keeps duplicate-value disambiguation correct.
// Tune upward if OCR/CSV ordering drift exceeds one row span.
const WINDOW = 12;

const range = (start: number, last: number): number[] =>
    Array.from({ length: last - start + 1 }, (_, i) => start + i);

function matchFromCursor(
    ocrWords: OcrWord[],
    cursor: number,
    target: string,
): { ids: number[]; nextCursor: number } | null {
    if (!target) return null;
    const end = Math.min(ocrWords.length, cursor + WINDOW);

    for (let start = cursor; start < end; start++) {
        let concat = "";
        for (let last = start; last < end; last++) {
            concat += normalize(ocrWords[last].text);
            if (concat === target) {
                return { ids: range(start, last), nextCursor: last + 1 };
            }
            if (concat.length > target.length) break;
        }
    }
    return null;
}

// Levenshtein edit distance between two normalized strings (rolling two-row DP).
export function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array<number>(n + 1);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

// 0–1 similarity; 1 means identical. Used to judge near-miss OCR reads.
export const similarity = (a: string, b: string): number => {
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
};

// Minimum similarity for a fuzzy match to count. 0.8 tolerates a handful of
// glyph misreads (e.g. "I" -> "|", "0" -> "O") without matching unrelated text.
const FUZZY_THRESHOLD = 0.8;

// Best contiguous run of OCR words in [lo, hi) whose normalized concatenation is
// most similar to target, provided it clears FUZZY_THRESHOLD.
function findFuzzyMatch(
    ocrWords: OcrWord[],
    lo: number,
    hi: number,
    target: string,
): { ids: number[]; similarity: number } | null {
    if (!target || lo >= hi) return null;
    const maxConcat = Math.ceil(target.length * 1.5) + 2;

    let best: { ids: number[]; similarity: number } | null = null;
    for (let start = lo; start < hi; start++) {
        let concat = "";
        for (let last = start; last < hi; last++) {
            concat += normalize(ocrWords[last].text);
            if (concat.length > maxConcat) break;
            const sim = similarity(concat, target);
            if (sim >= FUZZY_THRESHOLD && (!best || sim > best.similarity)) {
                best = { ids: range(start, last), similarity: sim };
            }
        }
    }
    return best;
}

// Internal working cell — carries *positional* indices into the sanitized word
// array while the matcher runs (the walk and fuzzy bounds need contiguous order).
// Converted to stable UUIDs only when the public CellProvenance is emitted.
type WorkingCell = {
    rowIndex: number;
    colIndex: number;
    value: string;
    wordIdx: number[];
    matchStatus: CellProvenance['matchStatus'];
};

// Second pass: for cells the exact walk left unmatched, search the positional
// gap between their nearest matched neighbours (in reading order) for a close
// OCR run. Bounding the search to that gap keeps ordering intact and prevents
// stealing words already claimed by another cell. A perfect hit is promoted to a
// normal match; anything below 1.0 is flagged "fuzzy" so confidence is lowered.
function fuzzyMatchPass(result: WorkingCell[][], ocrWords: OcrWord[]): void {
    const flat = result.flat();
    for (let i = 0; i < flat.length; i++) {
        const cell = flat[i];
        if (cell.matchStatus !== "unmatched") continue;
        const target = normalize(cell.value);
        if (!target) continue;

        // Matched cells have monotonically increasing word indices, so the nearest
        // matched neighbour on each side gives the tightest positional bound.
        let lo = 0;
        for (let j = i - 1; j >= 0; j--) {
            if (flat[j].wordIdx.length > 0) { lo = Math.max(...flat[j].wordIdx) + 1; break; }
        }
        let hi = ocrWords.length;
        for (let j = i + 1; j < flat.length; j++) {
            if (flat[j].wordIdx.length > 0) { hi = Math.min(...flat[j].wordIdx); break; }
        }

        const found = findFuzzyMatch(ocrWords, lo, hi, target);
        if (!found) continue;

        cell.wordIdx = found.ids;
        cell.matchStatus = found.similarity >= 1
            ? (found.ids.length > 1 ? "multi_word" : "matched")
            : "fuzzy";
    }
}

// Walk CSV rows and OCR words in parallel reading order.
// Cursor advances only on a match, so one unmatched cell cannot desync the rest.
export const matchCellsToOcr = (
    csvRows: string[][],
    ocrWords: OcrWord[],
): CellProvenance[][] => {
    let cursor = 0;
    const working: WorkingCell[][] = [];

    for (let r = 0; r < csvRows.length; r++) {
        const rowOut: WorkingCell[] = [];
        for (let c = 0; c < csvRows[r].length; c++) {
            const value = csvRows[r][c];
            const target = normalize(value);
            const match = matchFromCursor(ocrWords, cursor, target);

            if (match) {
                cursor = match.nextCursor;
                rowOut.push({
                    rowIndex: r, colIndex: c, value,
                    wordIdx: match.ids,
                    matchStatus: match.ids.length > 1 ? "multi_word" : "matched",
                });
            } else {
                rowOut.push({ rowIndex: r, colIndex: c, value, wordIdx: [], matchStatus: "unmatched" });
            }
        }
        working.push(rowOut);
    }

    // Second pass — fuzzy-match whatever the exact walk could not place.
    fuzzyMatchPass(working, ocrWords);

    // Convert positional indices to stable UUIDs for storage/resolution.
    return working.map(row =>
        row.map(cell => ({
            rowIndex: cell.rowIndex,
            colIndex: cell.colIndex,
            value: cell.value,
            wordIds: cell.wordIdx.map(i => ocrWords[i].id),
            matchStatus: cell.matchStatus,
        }))
    );
};
