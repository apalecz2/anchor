import type { OcrWord } from '../features/ocr/types';
import type { LineWord } from '../features/extraction/types';

export const generateLinesFromWords = (words: OcrWord[]): LineWord[][] => {
    if (words.length === 0) return [];
    const lines: LineWord[][] = [];
    let currentLine: LineWord[] = [];
    let currentTop = words[0].box_coords.top;

    words.forEach((word, index) => {
        if (Math.abs(word.box_coords.top - currentTop) > 15) {
            lines.push(currentLine);
            currentLine = [{ text: word.text, originalIndex: index }];
            currentTop = word.box_coords.top;
        } else {
            currentLine.push({ text: word.text, originalIndex: index });
        }
    });

    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
};

export const sortWords = (words: OcrWord[]) => {
    return [...words].sort((a, b) => {
        const verticalDiff = a.box_coords.top - b.box_coords.top;
        if (Math.abs(verticalDiff) > 15) return verticalDiff;
        return a.box_coords.left - b.box_coords.left;
    });
};