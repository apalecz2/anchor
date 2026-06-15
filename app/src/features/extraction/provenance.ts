import type { OcrWord, BoundingBox } from '../ocr/types';
import { sortWords } from '../../utils/ocrTransforms';
import type { CellProvenance } from './types';

export const normalize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Sort words into reading order, strip column-rule pipe glyphs, drop empties.
// The integer index in the returned array IS the word ID used by CellProvenance.wordIds.
// Must be called before anything else — all downstream indexes are relative to this array.
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
export const getCellSourceBox = (prov: CellProvenance, ocrWords: OcrWord[]): BoundingBox | null => {
    if (prov.wordIds.length === 0) return null;
    return unionBoxes(prov.wordIds.map(id => ocrWords[id].box_coords));
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
function levenshtein(a: string, b: string): number {
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
const similarity = (a: string, b: string): number => {
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

// Second pass: for cells the exact walk left unmatched, search the positional
// gap between their nearest matched neighbours (in reading order) for a close
// OCR run. Bounding the search to that gap keeps ordering intact and prevents
// stealing words already claimed by another cell. A perfect hit is promoted to a
// normal match; anything below 1.0 is flagged "fuzzy" so confidence is lowered.
function fuzzyMatchPass(result: CellProvenance[][], ocrWords: OcrWord[]): void {
    const flat = result.flat();
    for (let i = 0; i < flat.length; i++) {
        const cell = flat[i];
        if (cell.matchStatus !== "unmatched") continue;
        const target = normalize(cell.value);
        if (!target) continue;

        // Matched cells have monotonically increasing wordIds, so the nearest
        // matched neighbour on each side gives the tightest positional bound.
        let lo = 0;
        for (let j = i - 1; j >= 0; j--) {
            if (flat[j].wordIds.length > 0) { lo = Math.max(...flat[j].wordIds) + 1; break; }
        }
        let hi = ocrWords.length;
        for (let j = i + 1; j < flat.length; j++) {
            if (flat[j].wordIds.length > 0) { hi = Math.min(...flat[j].wordIds); break; }
        }

        const found = findFuzzyMatch(ocrWords, lo, hi, target);
        if (!found) continue;

        cell.wordIds = found.ids;
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
    const result: CellProvenance[][] = [];

    for (let r = 0; r < csvRows.length; r++) {
        const rowOut: CellProvenance[] = [];
        for (let c = 0; c < csvRows[r].length; c++) {
            const value = csvRows[r][c];
            const target = normalize(value);
            const match = matchFromCursor(ocrWords, cursor, target);

            if (match) {
                cursor = match.nextCursor;
                rowOut.push({
                    rowIndex: r, colIndex: c, value,
                    wordIds: match.ids,
                    matchStatus: match.ids.length > 1 ? "multi_word" : "matched",
                });
            } else {
                rowOut.push({ rowIndex: r, colIndex: c, value, wordIds: [], matchStatus: "unmatched" });
            }
        }
        result.push(rowOut);
    }

    // Second pass — fuzzy-match whatever the exact walk could not place.
    fuzzyMatchPass(result, ocrWords);

    return result;
};
