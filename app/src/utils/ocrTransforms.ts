import type { OcrWord } from '../features/ocr/types';
import type { LineWord } from '../features/extraction/types';

const lineThreshold = (imageHeight: number) => Math.max(2, imageHeight * 0.005);

/**
 * Rebuild spatially-accurate text from the structured words array.
 * Words already sorted by Y then X (from sortWords during extraction).
 * Each word is placed at a character column proportional to its pixel X
 * position, so inter-column spacing mirrors the visual layout of the image.
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

    return lineGroups.map(line => {
        let result = '';
        for (const word of line) {
            const targetCol = Math.round(word.box_coords.left / avgCharWidth);
            if (targetCol > result.length) {
                result += ' '.repeat(targetCol - result.length);
            } else if (result.length > 0) {
                result += ' ';
            }
            result += word.text;
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

/**
 * Formats OCR words as an indexed word list for the LLM prompt (§3).
 * Each word's index in the input array becomes its ID — the same integer
 * the model will emit as wordId in the pipe-format output.
 * Words must be pre-sorted in reading order (use sortWords first).
 */
export const formatIndexedOcrWordList = (words: OcrWord[], imageHeight: number): string => {
    if (words.length === 0) return 'OCR words (id:"text"@conf):\n(none)';

    const threshold = lineThreshold(imageHeight);
    const lineGroups: { idx: number; word: OcrWord }[][] = [];
    let currentLine: { idx: number; word: OcrWord }[] = [{ idx: 0, word: words[0] }];
    let currentTop = words[0].box_coords.top;

    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (Math.abs(w.box_coords.top - currentTop) > threshold) {
            lineGroups.push(currentLine);
            currentLine = [{ idx: i, word: w }];
            currentTop = w.box_coords.top;
        } else {
            currentLine.push({ idx: i, word: w });
        }
    }
    lineGroups.push(currentLine);

    const formattedLines = lineGroups.map(line =>
        line.map(({ idx, word }) => `${idx}:"${word.text}"@${Math.round(word.confidence)}`).join(' ')
    );

    return `OCR words (id:"text"@conf):\n${formattedLines.join('\n')}`;
};

export const sortWords = (words: OcrWord[], imageHeight: number) => {
    const threshold = lineThreshold(imageHeight);
    return [...words].sort((a, b) => {
        const verticalDiff = a.box_coords.top - b.box_coords.top;
        if (Math.abs(verticalDiff) > threshold) return verticalDiff;
        return a.box_coords.left - b.box_coords.left;
    });
};

// ---------------------------------------------------------------------------
// Row-chunking utilities (§9) — for large tables that exceed ~15–20 rows.
// Use these to bound max_tokens per call and improve small-model accuracy.
// ---------------------------------------------------------------------------

// Trigger chunking when row count exceeds this threshold (§9).
export const CHUNK_ROW_THRESHOLD = 15;
// Maximum rows per chunk sent to the model.
export const CHUNK_SIZE = 10;

// A vertical band in image-coordinate space covering one or more text lines.
export type RowBand = { top: number; bottom: number };

// Returns one RowBand per detected text line (sorted top-to-bottom).
// Words must be pre-sorted (use sortWords first).
export const getRowBands = (words: OcrWord[], imageHeight: number): RowBand[] => {
    if (words.length === 0) return [];
    const threshold = lineThreshold(imageHeight);
    const bands: RowBand[] = [];
    let bandTop = words[0].box_coords.top;
    let bandBottom = words[0].box_coords.top + words[0].box_coords.height;
    let lineTop = words[0].box_coords.top;

    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (Math.abs(w.box_coords.top - lineTop) > threshold) {
            // New line — close the current band and start a fresh one
            bands.push({ top: bandTop, bottom: bandBottom });
            bandTop = w.box_coords.top;
            bandBottom = w.box_coords.top + w.box_coords.height;
            lineTop = w.box_coords.top;
        } else {
            bandBottom = Math.max(bandBottom, w.box_coords.top + w.box_coords.height);
        }
    }
    bands.push({ top: bandTop, bottom: bandBottom });
    return bands;
};

// Split a flat array of RowBands into chunks of at most chunkSize rows each.
export const chunkRowBands = (bands: RowBand[], chunkSize: number): RowBand[][] => {
    const chunks: RowBand[][] = [];
    for (let i = 0; i < bands.length; i += chunkSize) {
        chunks.push(bands.slice(i, i + chunkSize));
    }
    return chunks;
};

// Merge a group of RowBands into a single y-extent for image cropping.
// Returns { top, bottom } in natural image pixels.
export const mergeRowBands = (bands: RowBand[]): RowBand => ({
    top:    Math.min(...bands.map(b => b.top)),
    bottom: Math.max(...bands.map(b => b.bottom)),
});

// Return the original word indices (IDs) of words whose vertical midpoint
// falls within [band.top, band.bottom]. Original indices are preserved so
// the model receives e.g. "12:..." not "0:..." — keeping wordId references
// consistent across chunks (§9).
export const getWordIndicesInBand = (words: OcrWord[], band: RowBand): number[] => {
    const result: number[] = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const mid = w.box_coords.top + w.box_coords.height / 2;
        if (mid >= band.top && mid <= band.bottom) result.push(i);
    }
    return result;
};

// Format a subset of words by original index for the LLM prompt, preserving
// original IDs. Pass the full sorted words array and the indices returned by
// getWordIndicesInBand. Groups indices back into lines using the same threshold.
export const formatIndexedOcrWordSubset = (
    words: OcrWord[],
    indices: number[],
    imageHeight: number,
): string => {
    if (indices.length === 0) return 'OCR words (id:"text"@conf):\n(none)';
    const threshold = lineThreshold(imageHeight);
    const lineGroups: { idx: number; word: OcrWord }[][] = [];
    let cur: { idx: number; word: OcrWord }[] = [{ idx: indices[0], word: words[indices[0]] }];
    let curTop = words[indices[0]].box_coords.top;

    for (let i = 1; i < indices.length; i++) {
        const idx = indices[i];
        const w = words[idx];
        if (Math.abs(w.box_coords.top - curTop) > threshold) {
            lineGroups.push(cur);
            cur = [{ idx, word: w }];
            curTop = w.box_coords.top;
        } else {
            cur.push({ idx, word: w });
        }
    }
    lineGroups.push(cur);

    const lines = lineGroups.map(line =>
        line.map(({ idx, word }) => `${idx}:"${word.text}"@${Math.round(word.confidence)}`).join(' ')
    );
    return `OCR words (id:"text"@conf):\n${lines.join('\n')}`;
};
