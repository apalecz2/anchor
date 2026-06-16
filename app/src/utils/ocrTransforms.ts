import type { OcrWord } from '../features/ocr/types';
import type { LineWord } from '../features/extraction/types';

const lineThreshold = (imageHeight: number) => Math.max(2, imageHeight * 0.005);

/**
 * Cluster words into reading-order lines, then sort each line left-to-right.
 *
 * This is the single source of truth for line grouping — `sortWords`,
 * `buildTableText`, and `generateLinesFromWords` all build on it so the three
 * never drift apart (previously each rolled its own threshold logic).
 *
 * The clustering is a single pass over top-sorted words carrying a running
 * anchor: a word opens a new line only when its `top` is more than `threshold`
 * below the *previous* word's `top` (a gap), not below the line's first word.
 * This is transitive — unlike a pairwise "is A within threshold of B" comparator,
 * which is not a valid sort order (for A≈B, B≈C, A≉C it contradicts itself) and
 * let noisy / slightly-tilted scans scramble reading order.
 *
 * Why gap-to-previous and not anchor-to-first: on low-resolution scans the
 * threshold is only a few pixels, and a single visual row can still drift more
 * than that across its width (slight tilt, or digits sitting a hair lower than
 * the caps beside them). Anchoring to the first word caps a line's vertical
 * span at `threshold` and exiles such a word to the next line — which reorders
 * it relative to its row and silently desyncs the provenance cursor walk (e.g.
 * a course number landing after its description instead of beside its code).
 * Comparing to the previous word lets the line follow the drift, while the large
 * gap between real rows still splits them.
 */
export const groupWordsIntoLines = (words: OcrWord[], imageHeight: number): OcrWord[][] => {
    if (words.length === 0) return [];
    const threshold = lineThreshold(imageHeight);

    const byTop = [...words].sort((a, b) => a.box_coords.top - b.box_coords.top);

    const lines: OcrWord[][] = [];
    let currentLine: OcrWord[] = [byTop[0]];
    let prevTop = byTop[0].box_coords.top;

    for (let i = 1; i < byTop.length; i++) {
        const w = byTop[i];
        // byTop is ascending, so the gap from the previous word is always >= 0.
        if (w.box_coords.top - prevTop > threshold) {
            lines.push(currentLine);
            currentLine = [w];
        } else {
            currentLine.push(w);
        }
        prevTop = w.box_coords.top;
    }
    lines.push(currentLine);

    for (const line of lines) {
        line.sort((a, b) => a.box_coords.left - b.box_coords.left);
    }
    return lines;
};

/**
 * Rebuild spatially-accurate text from the structured words array.
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

    // Derive a pixels-per-character scale from the word boxes themselves.
    let totalPx = 0, totalChars = 0;
    for (const w of words) {
        if (w.text.length > 0 && w.box_coords.width > 0) {
            totalPx += w.box_coords.width;
            totalChars += w.text.length;
        }
    }
    const avgCharWidth = totalChars > 0 ? totalPx / totalChars : 8;

    const lineGroups = groupWordsIntoLines(words, naturalHeight);

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

export const generateLinesFromWords = (words: OcrWord[], imageHeight: number): LineWord[][] =>
    groupWordsIntoLines(words, imageHeight).map(line =>
        line.map(word => ({ text: word.text, wordId: word.id }))
    );

// Reading order: lines top-to-bottom, words left-to-right within each line.
export const sortWords = (words: OcrWord[], imageHeight: number): OcrWord[] =>
    groupWordsIntoLines(words, imageHeight).flat();
