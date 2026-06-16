import { describe, it, expect } from 'vitest';
import type { OcrWord } from '../ocr/types';
import {
    matchCellsToOcr,
    getCellSourceBox,
    sanitizeWordsForProvenance,
    levenshtein,
    similarity,
    normalize,
} from './provenance';

let nextId = 0;
const word = (text: string, left = 0, top = 0): OcrWord => ({
    id: `w${nextId++}`,
    text,
    confidence: 90,
    box_coords: { left, top, width: 10, height: 10 },
});

describe('normalize', () => {
    it('lowercases and strips non-alphanumerics', () => {
        expect(normalize('1,250')).toBe('1250');
        expect(normalize('Calc.')).toBe('calc');
        expect(normalize('  A-B ')).toBe('ab');
    });
});

describe('levenshtein / similarity', () => {
    it('measures edit distance', () => {
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('abc', 'abc')).toBe(0);
        expect(levenshtein('kitten', 'sitting')).toBe(3);
    });
    it('similarity is 1 for identical and degrades with edits', () => {
        expect(similarity('abc', 'abc')).toBe(1);
        expect(similarity('', '')).toBe(1);
        expect(similarity('calcforengi', 'calcforeng')).toBeGreaterThan(0.8);
    });
});

describe('matchCellsToOcr — exact walk', () => {
    it('matches single and multi-word cells and stores stable UUIDs', () => {
        const w = [word('Course'), word('Credits'), word('Math'), word('101'), word('3.0')];
        const csv = [['Course', 'Credits'], ['Math 101', '3.0']];
        const prov = matchCellsToOcr(csv, w);

        expect(prov[0][0].wordIds).toEqual([w[0].id]);
        expect(prov[0][0].matchStatus).toBe('matched');
        expect(prov[1][0].wordIds).toEqual([w[2].id, w[3].id]);
        expect(prov[1][0].matchStatus).toBe('multi_word');
        expect(prov[1][1].wordIds).toEqual([w[4].id]);
    });

    it('disambiguates duplicate values by sequence position', () => {
        const w = [word('A'), word('B'), word('A'), word('C')];
        const csv = [['A', 'B'], ['A', 'C']];
        const prov = matchCellsToOcr(csv, w);
        // First "A" -> first word; second "A" -> third word (cursor advanced past it)
        expect(prov[0][0].wordIds).toEqual([w[0].id]);
        expect(prov[1][0].wordIds).toEqual([w[2].id]);
    });

    it('leaves a cell with no plausible source unmatched without desyncing the row', () => {
        const w = [word('Alpha'), word('Gamma')];
        const csv = [['Alpha', 'zzzzz', 'Gamma']];
        const prov = matchCellsToOcr(csv, w);
        expect(prov[0][0].wordIds).toEqual([w[0].id]);
        expect(prov[0][1].matchStatus).toBe('unmatched');
        expect(prov[0][1].wordIds).toEqual([]);
        expect(prov[0][2].wordIds).toEqual([w[1].id]); // cursor stayed aligned
    });
});

describe('matchCellsToOcr — fuzzy second pass', () => {
    it('recovers a single-glyph OCR misread as a fuzzy match', () => {
        // OCR misread "I" as "|" (which sanitizes to empty); exact walk fails.
        const w = [word('Calc'), word('for'), word('eng'), word('|')];
        const csv = [['Calc for eng I']];
        const prov = matchCellsToOcr(csv, w);
        expect(prov[0][0].matchStatus).toBe('fuzzy');
        expect(prov[0][0].wordIds).toEqual([w[0].id, w[1].id, w[2].id]);
    });

    it('does not fuzzy-match genuinely unrelated text', () => {
        const w = [word('Calc')];
        const csv = [['zzzzzzzz']];
        const prov = matchCellsToOcr(csv, w);
        expect(prov[0][0].matchStatus).toBe('unmatched');
        expect(prov[0][0].wordIds).toEqual([]);
    });
});

describe('getCellSourceBox — UUID resolution (H2)', () => {
    const w = [word('Math', 0, 0), word('101', 40, 0), word('3.0', 100, 0)];
    const csv = [['Math 101', '3.0']];
    const prov = matchCellsToOcr(csv, w);

    it('unions the boxes of the mapped words', () => {
        const box = getCellSourceBox(prov[0][0], w);
        expect(box).toEqual({ left: 0, top: 0, width: 50, height: 10 });
    });

    it('resolves correctly even after the words array is reordered', () => {
        const reordered = [w[2], w[0], w[1]];
        const box = getCellSourceBox(prov[0][0], reordered);
        expect(box).toEqual({ left: 0, top: 0, width: 50, height: 10 });
    });

    it('returns null (no highlight) when a mapped word was deleted', () => {
        const withoutOne = w.filter(x => x.id !== w[1].id);
        expect(getCellSourceBox(prov[0][0], withoutOne)).toBeNull();
    });

    it('returns null for an unmatched cell', () => {
        const unmatched = matchCellsToOcr([['zzzz']], [word('abc')]);
        expect(getCellSourceBox(unmatched[0][0], [word('abc')])).toBeNull();
    });
});

describe('sanitizeWordsForProvenance', () => {
    it('strips wrapping pipe glyphs but keeps pipe-only reads for the LLM, preserving ids', () => {
        const w = [word('Total', 0, 0), word('|', 50, 0), word('|amount|', 100, 0)];
        const out = sanitizeWordsForProvenance(w, 1000);
        // "|amount|" -> "amount"; a pipe-only word is intentionally retained as-is
        // (a possible OCR misread the model can cross-reference), not dropped.
        expect(out.map(x => x.text)).toEqual(['Total', '|', 'amount']);
        // The kept words retain their original stable ids.
        expect(out.find(x => x.text === 'amount')?.id).toBe(w[2].id);
    });
});
