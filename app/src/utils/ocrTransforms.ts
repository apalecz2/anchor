import type { OcrWord } from '../features/ocr/types';
import type { LineWord } from '../features/extraction/types';

const lineThreshold = (imageHeight: number) => Math.max(2, imageHeight * 0.005);

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
