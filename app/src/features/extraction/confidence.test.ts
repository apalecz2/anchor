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

    it('treats a trailing tab as a real empty final cell', () => {
        const { rows } = parseTSVWithOffsets('A\tB\t');
        expect(rows).toEqual([['A', 'B', '']]);
    });

    it('handles a single-column table', () => {
        const { rows } = parseTSVWithOffsets('Header\nrow1\nrow2');
        expect(rows).toEqual([['Header'], ['row1'], ['row2']]);
    });

    it('preserves ragged rows (different column counts)', () => {
        const { rows } = parseTSVWithOffsets('A\tB\tC\nX\tY');
        expect(rows).toEqual([['A', 'B', 'C'], ['X', 'Y']]);
    });

    it('handles CRLF inside a fenced block', () => {
        const { rows } = parseTSVWithOffsets('```tsv\r\nA\tB\r\nC\tD\r\n```');
        expect(rows).toEqual([['A', 'B'], ['C', 'D']]);
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

    it('blend >= 0.85 but llmMin < 0.5 is held out of high (gate)', () => {
        // blended = 0.4*0.9 + 0.6*1.0 = 0.96 >= 0.85, but llmMin 0.49 < 0.5
        expect(cellTrust('agree', 0.9, 0.49, 100)).toBe('medium');
    });

    it('lands exactly on the 0.65 medium boundary', () => {
        // blended = 0.4*0.65 + 0.6*0.65 = 0.65 -> medium
        expect(cellTrust('agree', 0.65, 0.65, 65)).toBe('medium');
    });

    it('treats null OCR as 0 in the blend for an agreeing cell', () => {
        // blended = 0.4*1 + 0.6*0 = 0.4 < 0.65 -> low even with a perfect LLM
        expect(cellTrust('agree', 1, 1, null)).toBe('low');
    });

    it('falls back to OCR alone when the LLM is unscored (null)', () => {
        // No usable LLM signal: trust the OCR match. Strong OCR -> high, weak -> low.
        expect(cellTrust('agree', null, null, 96)).toBe('high');
        expect(cellTrust('agree', null, null, 70)).toBe('medium');
        expect(cellTrust('agree', null, null, 40)).toBe('low');
        // image-only with no LLM signal has nothing to vouch for it -> low
        expect(cellTrust('image_only', null, null, null)).toBe('low');
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

    it('knocks a non-high fuzzy cell down to low', () => {
        const raw = 'Hi';
        const provFuzzy: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'Hi', wordIds: ['a'], matchStatus: 'fuzzy' },
        ]];
        // A shaky token + weak OCR keep the base trust at medium; fuzzy -> low.
        const lowWord: OcrWord = { ...wordA, confidence: 60 };
        const logprobs: TokenLogprob[] = [{ token: 'Hi', logprob: Math.log(0.6), charOffset: 0 }];
        const cell = computeProvenanceCells(provFuzzy, logprobs, raw, [lowWord])[0][0];
        expect(cell.confidence.trust).toBe('low');
    });

    it('excludes null logprobs from the mean instead of treating them as prob 1.0 (M17)', () => {
        const raw = 'Hi';
        const prov: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'Hi', wordIds: ['a'], matchStatus: 'matched' },
        ]];
        // Two tokens land in the cell range [0,2): one shaky real logprob and one null.
        // If null were treated as logprob 0 (prob 1.0) it would inflate the mean.
        const shaky: TokenLogprob[] = [
            { token: 'H', logprob: Math.log(0.5), charOffset: 0 },
            { token: 'i', logprob: null, charOffset: 1 },
        ];
        const cell = computeProvenanceCells(prov, shaky, raw, [wordA])[0][0];
        // Mean over the single usable token only => exp(log 0.5) = 0.5, not inflated.
        expect(cell.confidence.llmMean).toBeCloseTo(0.5, 5);
        expect(cell.confidence.llmMin).toBeCloseTo(0.5, 5);
    });

    it('scores llmMean/llmMin as null (unscored) when a cell has no usable logprobs', () => {
        const raw = 'Hi';
        const prov: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'Hi', wordIds: ['a'], matchStatus: 'matched' },
        ]];
        const cell = computeProvenanceCells(prov, [], raw, [wordA])[0][0];
        expect(cell.confidence.llmMean).toBeNull();
        expect(cell.confidence.llmMin).toBeNull();
    });

    it('maps each logprob offset to the cell whose [start,end) contains it', () => {
        // raw = "AB\tCD" -> cell0 range [0,2), cell1 range [3,5)
        const raw = 'AB\tCD';
        const prov: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'AB', wordIds: [], matchStatus: 'unmatched' },
            { rowIndex: 0, colIndex: 1, value: 'CD', wordIds: [], matchStatus: 'unmatched' },
        ]];
        // offset 1 -> cell0; offset 4 -> cell1; offset 2 (the tab) -> neither.
        const logprobs: TokenLogprob[] = [
            { token: 'A', logprob: Math.log(0.9), charOffset: 1 },
            { token: 'D', logprob: Math.log(0.3), charOffset: 4 },
            { token: '\t', logprob: Math.log(0.1), charOffset: 2 },
        ];
        const cells = computeProvenanceCells(prov, logprobs, raw, []);
        expect(cells[0][0].confidence.llmMean).toBeCloseTo(0.9, 5);
        expect(cells[0][1].confidence.llmMean).toBeCloseTo(0.3, 5);
    });

    it('marks a single boundary-merged token cell as unscored, not low', () => {
        // raw = "AB\tCD" -> cell0 content [0,2), cell1 content [3,5). The tokenizer
        // emits the value with its leading tab fused on: "\tCD" starts on the tab
        // (offset 2 < cell1 start 3). That token's probability reflects tokenizer
        // segmentation, not value certainty, so it's excluded — leaving cell1 with
        // no usable value logprob => llmMean null (unscored), NOT a misleading 0.8
        // or 0%. cell0's "AB" starts at content start and scores normally.
        const raw = 'AB\tCD';
        const prov: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'AB', wordIds: [], matchStatus: 'unmatched' },
            { rowIndex: 0, colIndex: 1, value: 'CD', wordIds: [], matchStatus: 'unmatched' },
        ]];
        const logprobs: TokenLogprob[] = [
            { token: 'AB', logprob: Math.log(0.9), charOffset: 0 },
            { token: '\tCD', logprob: Math.log(0.3), charOffset: 2 },
        ];
        const cells = computeProvenanceCells(prov, logprobs, raw, []);
        expect(cells[0][0].confidence.llmMean).toBeCloseTo(0.9, 5);
        expect(cells[0][1].confidence.llmMean).toBeNull();
    });

    it('keeps the clean value tokens when only the first token is boundary-merged', () => {
        // raw = "AB\tCDE" -> cell1 content [3,6). Tokens: "\tC" (boundary, offset 2)
        // then "DE" (offset 4). The boundary token is dropped; "DE" still scores the
        // cell, so a multi-token value keeps a real (high) confidence.
        const raw = 'AB\tCDE';
        const prov: CellProvenance[][] = [[
            { rowIndex: 0, colIndex: 0, value: 'AB', wordIds: [], matchStatus: 'unmatched' },
            { rowIndex: 0, colIndex: 1, value: 'CDE', wordIds: [], matchStatus: 'unmatched' },
        ]];
        const logprobs: TokenLogprob[] = [
            { token: 'AB', logprob: Math.log(0.9), charOffset: 0 },
            { token: '\tC', logprob: Math.log(0.2), charOffset: 2 },  // boundary -> excluded
            { token: 'DE', logprob: Math.log(0.95), charOffset: 4 },
        ];
        const cells = computeProvenanceCells(prov, logprobs, raw, []);
        expect(cells[0][1].confidence.llmMean).toBeCloseTo(0.95, 5);
    });
});
