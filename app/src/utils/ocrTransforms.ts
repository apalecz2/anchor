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

export const sortWords = (words: OcrWord[], imageHeight: number) => {
    const threshold = lineThreshold(imageHeight);
    return [...words].sort((a, b) => {
        const verticalDiff = a.box_coords.top - b.box_coords.top;
        if (Math.abs(verticalDiff) > threshold) return verticalDiff;
        return a.box_coords.left - b.box_coords.left;
    });
};
