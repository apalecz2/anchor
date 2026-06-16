import { describe, it, expect } from 'vitest';
import type { OcrWord } from '../ocr/types';
import type { CellProvenance, TokenLogprob } from './types';
import { parseTSVWithOffsets, cellTrust, computeProvenanceCells } from './confidence';

describe('parseTSVWithOffsets', () => {
    it('splits a plain tab-separated table', () => {
        const { rows } = parseTSVWithOffsets('Course\tCredits\nMath 101\t3.0');
        expect(rows).toEqual([['Course', 'Credits'], ['Math 101', '3.0']]);
    });

    it('strips surrounding ```tsv code fences', () => {
        const { rows } = parseTSVWithOffsets('```tsv\nA\tB\nC\tD\n```');
        expect(rows).toEqual([['A', 'B'], ['C', 'D']]);
    });

    it('handles CRLF line endings', () => {
        const { rows } = parseTSVWithOffsets('A\tB\r\nC\tD');
        expect(rows).toEqual([['A', 'B'], ['C', 'D']]);
    });

    it('skips blank lines between rows', () => {
        const { rows } = parseTSVWithOffsets('A\tB\n\n\nC\tD\n');
        expect(rows).toEqual([['A', 'B'], ['C', 'D']]);
    });

    it('reports cell char ranges aligned to the raw string', () => {
        const raw = 'AB\tCD';
        const { cellRanges } = parseTSVWithOffsets(raw);
        expect(cellRanges[0][0]).toEqual({ start: 0, end: 2 });
        expect(cellRanges[0][1]).toEqual({ start: 3, end: 5 });
    });
});

describe('cellTrust', () => {
    it('is low on disagreement regardless of scores', () => {
        expect(cellTrust('disagree', 1, 1, 100)).toBe('low');
    });

    it('caps image-only cells at medium and drops to low when the LLM is unsure', () => {
        expect(cellTrust('image_only', 0.9, 0.9, null)).toBe('medium');
        expect(cellTrust('image_only', 0.5, 0.5, null)).toBe('low');
    });

    it('blends LLM + OCR for agreeing cells', () => {
        expect(cellTrust('agree', 1, 1, 100)).toBe('high');
        // high blend but a single shaky token (low min) is held back from high
        expect(cellTrust('agree', 1, 0.2, 100)).toBe('medium');
        // mid blend -> medium
        expect(cellTrust('agree', 0.7, 0.7, 70)).toBe('medium');
        // weak blend -> low
        expect(cellTrust('agree', 0.4, 0.4, 40)).toBe('low');
    });
});

describe('computeProvenanceCells', () => {
    const wordA: OcrWord = { id: 'a', text: 'Hi', confidence: 95, box_coords: { left: 0, top: 0, width: 10, height: 10 } };
    const wordB: OcrWord = { id: 'b', text: 'Yo', confidence: 80, box_coords: { left: 20, top: 0, width: 10, height: 10 } };

    it('resolves OCR confidence by UUID and flags image-only cells', () => {
        const raw = 'Hi\tYo';
        const prov: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'Hi', wordIds: ['a'], matchStatus: 'matched' },
            { rowIndex: 0, colIndex: 1, value: 'Yo', wordIds: [], matchStatus: 'unmatched' },
        ]];
        const logprobs: TokenLogprob[] = [];
        const cells = computeProvenanceCells(prov, logprobs, raw, [wordA, wordB]);

        expect(cells[0][0].confidence.ocr).toBe(95);
        expect(cells[0][0].confidence.agreement).toBe('agree');
        expect(cells[0][1].confidence.ocr).toBeNull();
        expect(cells[0][1].confidence.agreement).toBe('image_only');
    });

    it('knocks fuzzy-matched cells down one trust level', () => {
        const raw = 'Hi';
        const provHigh: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'Hi', wordIds: ['a'], matchStatus: 'matched' },
        ]];
        const provFuzzy: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'Hi', wordIds: ['a'], matchStatus: 'fuzzy' },
        ]];
        // A confident token so the base trust is high for the matched case.
        const logprobs: TokenLogprob[] = [{ token: 'Hi', logprob: 0, charOffset: 0 }];
        const high = computeProvenanceCells(provHigh, logprobs, raw, [wordA])[0][0];
        const fuzzy = computeProvenanceCells(provFuzzy, logprobs, raw, [wordA])[0][0];
        expect(high.confidence.trust).toBe('high');
        expect(fuzzy.confidence.trust).toBe('medium'); // high -> medium
    });
});
