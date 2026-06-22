import { describe, it, expect } from 'vitest';
import { groupWordsIntoLines, sortWords, generateLinesFromWords, buildTableText } from './ocrTransforms';
import { ocrWord as word } from '../test/fixtures';

// imageHeight 1000 -> lineThreshold = max(2, 5) = 5px
const H = 1000;

describe('groupWordsIntoLines', () => {
    it('clusters words on the same row and sorts each line left-to-right', () => {
        const b = word('b', 100, 0);
        const a = word('a', 0, 1);     // same row as b (within threshold)
        const c = word('c', 0, 200);   // next row
        const lines = groupWordsIntoLines([b, a, c], H);
        expect(lines.map(l => l.map(w => w.text))).toEqual([['a', 'b'], ['c']]);
    });

    it('keeps a gradually drifting (tilted) line together instead of scrambling', () => {
        // tops 0,4,8 with threshold 5: pairwise (0~4 ok, 4~8 ok, 0~8 not) is
        // intransitive. Gap-to-previous clustering follows the drift: each step
        // is <= threshold, so all three stay one line (then left-sorted).
        const w0 = word('x', 0, 0);
        const w1 = word('y', 20, 4);
        const w2 = word('z', 40, 8);
        const lines = groupWordsIntoLines([w0, w1, w2], H);
        expect(lines.map(l => l.map(w => w.text))).toEqual([['x', 'y', 'z']]);
    });

    it('does not exile a word whose top drifts past the FIRST word on a low-res row (regression)', () => {
        // Real low-res case: threshold ~2.9px. A course code and its number sit on
        // one row but the number is 3px lower than the code — more than the first
        // word's threshold, yet clearly the same row. It must stay grouped (and
        // left-ordered code -> number) so the provenance walk keeps them adjacent.
        const lowRes = 580; // lineThreshold = max(2, 2.9) = 2.9
        const code = word('ENGSCI', 22, 214);
        const num = word('1050', 225, 217);          // 217-214 = 3 > 2.9
        const descr = word('FOUNDATIONS', 427, 216);
        const lines = groupWordsIntoLines([code, num, descr], lowRes);
        expect(lines.length).toBe(1);
        expect(lines[0].map(w => w.text)).toEqual(['ENGSCI', '1050', 'FOUNDATIONS']);
    });

    it('still splits genuinely separate rows (large gap)', () => {
        const r1a = word('a', 0, 100);
        const r1b = word('b', 200, 101);
        const r2 = word('c', 0, 140);   // 39px below -> new row
        const lines = groupWordsIntoLines([r1a, r1b, r2], H);
        expect(lines.map(l => l.map(w => w.text))).toEqual([['a', 'b'], ['c']]);
    });

    it('returns [] for no words', () => {
        expect(groupWordsIntoLines([], H)).toEqual([]);
    });

    it('keeps a single short line together', () => {
        const lines = groupWordsIntoLines([word('a', 0, 0), word('b', 20, 0)], H);
        expect(lines.length).toBe(1);
    });

    it('applies the 2px floor on the line threshold for tiny images', () => {
        // imageHeight 100 -> 0.005*100 = 0.5, floored to 2px.
        const same = groupWordsIntoLines([word('a', 0, 0), word('b', 20, 2)], 100);
        expect(same.length).toBe(1); // gap 2 is not > 2 -> same line
        const split = groupWordsIntoLines([word('a', 0, 0), word('b', 20, 3)], 100);
        expect(split.length).toBe(2); // gap 3 > 2 -> split
    });
});

describe('sortWords', () => {
    it('produces top-to-bottom, left-to-right reading order', () => {
        const words = [word('3.0', 100, 200), word('Math', 0, 0), word('101', 40, 1)];
        expect(sortWords(words, H).map(w => w.text)).toEqual(['Math', '101', '3.0']);
    });

    it('does not mutate the input array', () => {
        const words = [word('b', 50, 0), word('a', 0, 0)];
        const snapshot = words.map(w => w.text);
        sortWords(words, H);
        expect(words.map(w => w.text)).toEqual(snapshot);
    });
});

describe('generateLinesFromWords', () => {
    it('emits LineWord rows carrying the stable word id', () => {
        const a = word('a', 0, 0);
        const c = word('c', 0, 200);
        const lines = generateLinesFromWords([a, c], H);
        expect(lines).toEqual([
            [{ text: 'a', wordId: a.id }],
            [{ text: 'c', wordId: c.id }],
        ]);
    });
});

describe('buildTableText', () => {
    it('keeps right-justified content in its column (no phantom trailing column)', () => {
        // Header defines two columns; a wide first cell holds left- and right-
        // justified words that must not spawn a third column.
        const words = [
            word('Name', 0, 0, 40),
            word('Code', 300, 0, 40),
            word('Alice', 0, 100, 50),
            word('A101', 200, 100, 40),   // right-justified within the first column
            word('CS', 300, 100, 20),
        ];
        const lines = buildTableText(words, H).split('\n');
        expect(lines.length).toBe(2);
        // No line should contain more whitespace-separated column starts than headers.
        expect(lines[0]).toContain('Name');
        expect(lines[0]).toContain('Code');
    });

    it('returns empty string for no words', () => {
        expect(buildTableText([], H)).toBe('');
    });

    it('falls back to a single column when the header is one word', () => {
        const words = [word('Title', 0, 0, 50), word('Value', 0, 100, 50)];
        const out = buildTableText(words, H);
        // Both rows render in one column; no phantom split.
        expect(out.split('\n')).toEqual(['Title', 'Value']);
    });

    it('pads a later column to its character anchor', () => {
        const words = [
            word('A', 0, 0, 10),
            word('B', 400, 0, 10),   // header second column far to the right
            word('x', 0, 100, 10),
            word('y', 400, 100, 10),
        ];
        const lines = buildTableText(words, H).split('\n');
        // The second column should be indented (spaces before it), aligned across rows.
        expect(lines[0].indexOf('B')).toBe(lines[1].indexOf('y'));
        expect(lines[0].indexOf('B')).toBeGreaterThan(1);
    });
});
