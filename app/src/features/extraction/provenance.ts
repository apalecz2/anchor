import type { OcrWord, BoundingBox } from '../ocr/types';
import { sortWords } from '../../utils/ocrTransforms';
import type { CellProvenance } from './types';

export const normalize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Sort words into reading order, strip column-rule pipe glyphs, drop empties.
// The integer index in the returned array IS the word ID used by CellProvenance.wordIds.
// Must be called before anything else — all downstream indexes are relative to this array.
export const sanitizeWordsForProvenance = (words: OcrWord[], naturalHeight: number): OcrWord[] =>
    sortWords(words, naturalHeight)
        .map(w => ({ ...w, text: w.text.replace(/^\|+|\|+$/g, "").trim() }))
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
    return result;
};
