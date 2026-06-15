import type { OcrWord } from '../features/ocr/types';
import type { LineWord } from '../features/extraction/types';

const lineThreshold = (imageHeight: number) => Math.max(2, imageHeight * 0.005);

/**
 * Rebuild spatially-accurate text from the structured words array.
 * Words already sorted by Y then X (from sortWords during extraction).
 *
 * Column boundaries are derived once from the header line (first row) and every
 * row is snapped to those columns. Real columns are vertically consistent across
 * rows, whereas a wide cell holding left- and right-justified content is not — so
 * pinning each row to the header's columns prevents that within-cell gap from
 * being mistaken for a column break (which previously spawned a phantom, unnamed
 * trailing column). Within a column, words are joined with a single space.
 */
export const buildTableText = (words: OcrWord[], naturalHeight: number): string => {
    if (words.length === 0) return '';
    const threshold = lineThreshold(naturalHeight);

    // Derive a pixels-per-character scale from the word boxes themselves.
    let totalPx = 0, totalChars = 0;
    for (const w of words) {
        if (w.text.length > 0 && w.box_coords.width > 0) {
            totalPx += w.box_coords.width;
            totalChars += w.text.length;
        }
    }
    const avgCharWidth = totalChars > 0 ? totalPx / totalChars : 8;

    const lineGroups: OcrWord[][] = [];
    let currentLine: OcrWord[] = [words[0]];
    let currentTop = words[0].box_coords.top;

    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (Math.abs(w.box_coords.top - currentTop) > threshold) {
            lineGroups.push(currentLine);
            currentLine = [w];
            currentTop = w.box_coords.top;
        } else {
            currentLine.push(w);
        }
    }
    lineGroups.push(currentLine);

    // Derive canonical column anchors (pixel left edges) from the header line.
    // A gap wider than ~3 spaces between header words starts a new column;
    // smaller gaps keep multi-word headers (e.g. "Course Number") in one column.
    const columnGap = avgCharWidth * 3;
    const headerLine = lineGroups[0];
    const anchors: number[] = [];
    let prevRight = -Infinity;
    for (const w of headerLine) {
        if (w.box_coords.left - prevRight > columnGap) {
            anchors.push(w.box_coords.left);
        }
        prevRight = w.box_coords.left + w.box_coords.width;
    }
    if (anchors.length === 0) anchors.push(headerLine[0].box_coords.left);

    // The column a word belongs to: the rightmost anchor at or left of the word.
    // A word that sits between two anchors (e.g. right-justified content in a wide
    // cell) maps to the left column rather than spilling into the next one.
    const columnOf = (left: number): number => {
        let col = 0;
        for (let c = 1; c < anchors.length; c++) {
            if (left + avgCharWidth * 0.5 >= anchors[c]) col = c;
            else break;
        }
        return col;
    };

    return lineGroups.map(line => {
        // Bucket words into header columns, joining intra-column words with a space.
        const cells: string[] = new Array(anchors.length).fill('');
        for (const word of line) {
            const c = columnOf(word.box_coords.left);
            cells[c] = cells[c] ? `${cells[c]} ${word.text}` : word.text;
        }

        // Render cells padded to each column's character anchor.
        let result = '';
        for (let c = 0; c < anchors.length; c++) {
            if (!cells[c]) continue;
            const targetCol = Math.round(anchors[c] / avgCharWidth);
            if (targetCol > result.length) {
                result += ' '.repeat(targetCol - result.length);
            } else if (result.length > 0) {
                result += ' ';
            }
            result += cells[c];
        }
        return result;
    }).join('\n');
};

export const generateLinesFromWords = (words: OcrWord[], imageHeight: number): LineWord[][] => {
    if (words.length === 0) return [];
    const threshold = lineThreshold(imageHeight);
    const lines: LineWord[][] = [];
    let currentLine: LineWord[] = [];
    let currentTop = words[0].box_coords.top;

    words.forEach((word) => {
        if (Math.abs(word.box_coords.top - currentTop) > threshold) {
            lines.push(currentLine);
            currentLine = [{ text: word.text, wordId: word.id }];
            currentTop = word.box_coords.top;
        } else {
            currentLine.push({ text: word.text, wordId: word.id });
        }
    });

    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
};

export const sortWords = (words: OcrWord[], imageHeight: number) => {
    const threshold = lineThreshold(imageHeight);
    return [...words].sort((a, b) => {
        const verticalDiff = a.box_coords.top - b.box_coords.top;
        if (Math.abs(verticalDiff) > threshold) return verticalDiff;
        return a.box_coords.left - b.box_coords.left;
    });
};
