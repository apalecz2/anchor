import { describe, it, expect } from 'vitest';
import {
    matchCellsToOcr,
    getCellSourceBox,
    sanitizeWordsForProvenance,
    padProvenanceGrid,
    levenshtein,
    similarity,
    normalize,
    unclaimedWordsInRegion,
} from './provenance';
import { ocrWord as word, provenanceCell } from '../../test/fixtures';
import type { DeclaredGrid } from './types';

describe('normalize', () => {
    it('lowercases and strips non-alphanumerics', () => {
        expect(normalize('1,250')).toBe('1250');
        expect(normalize('Calc.')).toBe('calc');
        expect(normalize('  A-B ')).toBe('ab');
    });
});

describe('padProvenanceGrid', () => {
    it('pads short rows with synthetic empty cells up to the widest row', () => {
        const rows = [
            [provenanceCell('A', { rowIndex: 0, colIndex: 0 }), provenanceCell('B', { rowIndex: 0, colIndex: 1 })],
            [provenanceCell('x', { rowIndex: 1, colIndex: 0 })], // trailing empty cell omitted by the model
        ];
        const padded = padProvenanceGrid(rows);
        expect(padded[1]).toHaveLength(2);
        const synth = padded[1][1];
        expect(synth).toMatchObject({
            rowIndex: 1,
            colIndex: 1,
            value: '',
            wordIds: [],
            matchStatus: 'empty',
        });
        // Same confidence a clean empty cell gets from computeProvenanceCells.
        expect(synth.confidence).toEqual({
            llmMean: null, llmMin: null, ocr: null, agreement: 'agree', trust: 'high',
        });
        // Existing cells are untouched.
        expect(padded[0]).toBe(rows[0]);
        expect(padded[1][0]).toBe(rows[1][0]);
    });

    it('returns a rectangular grid unchanged (same reference)', () => {
        const rows = [
            [provenanceCell('A'), provenanceCell('B', { colIndex: 1 })],
            [provenanceCell('x', { rowIndex: 1 }), provenanceCell('y', { rowIndex: 1, colIndex: 1 })],
        ];
        expect(padProvenanceGrid(rows)).toBe(rows);
        expect(padProvenanceGrid([])).toEqual([]);
    });
});

describe('unclaimedWordsInRegion', () => {
    // A 2x2 arrangement of 10x10 words: centers at (5,5), (105,5), (5,105), (105,105).
    const words = [
        word('tl', 0, 0),
        word('tr', 100, 0),
        word('bl', 0, 100),
        word('br', 100, 100),
    ];
    const topRow = { lo: 0, hi: 10 };
    const leftCol = { lo: 0, hi: 10 };

    it('returns only words centered inside both bands', () => {
        expect(unclaimedWordsInRegion(words, new Set(), topRow, leftCol)).toEqual([0]);
        expect(unclaimedWordsInRegion(words, new Set(), topRow, { lo: 100, hi: 110 })).toEqual([1]);
    });

    it('skips words another cell already claimed', () => {
        expect(unclaimedWordsInRegion(words, new Set([0]), topRow, leftCol)).toEqual([]);
    });

    it('returns matches in reading order', () => {
        const all = unclaimedWordsInRegion(words, new Set(), { lo: 0, hi: 110 }, { lo: 0, hi: 110 });
        expect(all).toEqual([0, 1, 2, 3]);
    });

    it('tests the center, not overlap — a word straddling an edge falls to one side only', () => {
        // Word center y=5; a band ending at 4 excludes it even though the box overlaps.
        expect(unclaimedWordsInRegion(words, new Set(), { lo: 0, hi: 4 }, leftCol)).toEqual([]);
        expect(unclaimedWordsInRegion(words, new Set(), { lo: 5, hi: 20 }, leftCol)).toEqual([0]);
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

    it('accepts a fuzzy match exactly at the 0.8 similarity threshold', () => {
        // target "abcde" (5) vs OCR "abcdx" -> 1 edit / maxLen 5 = 0.8 -> accept
        const w = [word('abcdx')];
        const prov = matchCellsToOcr([['abcde']], w);
        expect(prov[0][0].matchStatus).toBe('fuzzy');
        expect(prov[0][0].wordIds).toEqual([w[0].id]);
    });

    it('rejects a fuzzy candidate just below the 0.8 threshold', () => {
        // target "abcd" (4) vs OCR "abcx" -> 1 edit / maxLen 4 = 0.75 -> reject
        const w = [word('abcx')];
        const prov = matchCellsToOcr([['abcd']], w);
        expect(prov[0][0].matchStatus).toBe('unmatched');
    });
});

describe('matchCellsToOcr — degenerate inputs', () => {
    it('returns [] for an empty CSV', () => {
        expect(matchCellsToOcr([], [word('a')])).toEqual([]);
    });

    it('leaves every cell unmatched when there are no OCR words', () => {
        const prov = matchCellsToOcr([['a', 'b']], []);
        expect(prov[0].every(c => c.matchStatus === 'unmatched')).toBe(true);
        expect(prov[0].every(c => c.wordIds.length === 0)).toBe(true);
    });

    it('leaves an all-unmatched row without throwing', () => {
        const prov = matchCellsToOcr([['zzz', 'yyy']], [word('abc')]);
        expect(prov[0].map(c => c.matchStatus)).toEqual(['unmatched', 'unmatched']);
    });
});

describe('matchCellsToOcr — grid cross-check pass (F2)', () => {
    // The OCR words for the last row arrive in the array in swapped reading order
    // (Y before B). The clean two-column geometry means the grid-first matcher places
    // every cell spatially, immune to the array-order swap that used to desync the
    // cursor walk.
    it('recovers a reading-order-desynced cell from its row and column anchors', () => {
        const H1 = word('H1', 0, 0);
        const H2 = word('H2', 100, 0);
        const A  = word('A', 0, 20);
        const X  = word('X', 100, 20);
        const Y  = word('Y', 100, 40);
        const B  = word('B', 0, 40);
        const w = [H1, H2, A, X, Y, B]; // reading order as the walk sees it
        const csv = [['H1', 'H2'], ['A', 'X'], ['B', 'Y']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[2][0].wordIds).toEqual([B.id]);      // exact walk
        expect(prov[2][1].wordIds).toEqual([Y.id]);       // grid recovered
        expect(prov[2][1].matchStatus).toBe('matched');
    });

    it('does not fire when a whole column is unmatched (no column anchor)', () => {
        // Both data values in column 1 are absent from OCR, so the column never gets
        // an anchor and the grid pass must leave these cells unmatched rather than
        // guessing.
        const w = [word('Name', 0, 0), word('Alice', 0, 20), word('Bob', 0, 40)];
        const csv = [['Name', 'Score'], ['Alice', '90'], ['Bob', '85']];
        const prov = matchCellsToOcr(csv, w);
        expect(prov[1][1].matchStatus).toBe('unmatched');
        expect(prov[2][1].matchStatus).toBe('unmatched');
    });

    it('triangulates via the band-based pass when column geometry is too messy for channels', () => {
        // Columns horizontally overlap (A reaches into column 1's x-range, Y starts
        // inside column 0's), so no whitespace channel exists and the grid-first
        // matcher bows out. The walk then desyncs on the swapped last row (grabs B,
        // leaving Y with nothing in-window), and only the band-based cross-check —
        // row band from the matched B, column band from H2/X above — recovers Y.
        const H1 = word('H1', 0, 0, 60);
        const H2 = word('H2', 80, 0, 60);
        const A  = word('A', 0, 20, 90);
        const X  = word('X', 100, 20, 40);
        const Y  = word('Y', 70, 40, 70);
        const B  = word('B', 0, 40, 60);
        const w = [H1, H2, A, X, Y, B];
        const csv = [['H1', 'H2'], ['A', 'X'], ['B', 'Y']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[2][0].wordIds).toEqual([B.id]);
        expect(prov[2][1].wordIds).toEqual([Y.id]);
        expect(prov[2][1].matchStatus).toBe('matched');
    });

    it('leaves a cell unmatched when nothing in its row∩column region matches', () => {
        // Grid bands exist (column 1 is anchored by H2/X, row 3 by B), but the only
        // free word in the intersection is unrelated, so the cell stays unmatched
        // rather than being force-fit to a non-match below the similarity threshold.
        const H1 = word('H1', 0, 0);
        const H2 = word('H2', 100, 0);
        const A  = word('A', 0, 20);
        const X  = word('X', 100, 20);
        const Q  = word('zzzzzz', 100, 40); // sits in column 1 / row 3 but is unrelated
        const B  = word('B', 0, 40);
        const w = [H1, H2, A, X, Q, B];
        const csv = [['H1', 'H2'], ['A', 'X'], ['B', 'Y']];
        const prov = matchCellsToOcr(csv, w);
        expect(prov[2][1].matchStatus).toBe('unmatched');
        expect(prov[2][1].wordIds).toEqual([]);
    });
});

describe('matchCellsToOcr — grid-first spatial matching', () => {
    it('matches a wrapped multi-line cell whose words interleave with other columns', () => {
        // "Linear Algebra and Applications" wraps: "Applications" sits on its own
        // visual line *below* "3.0", so in reading order the cell's words are not
        // contiguous and the cursor walk could never match them. The grid matcher
        // buckets by column band and spans both lines.
        const course       = word('Course', 0, 0, 60);
        const credits      = word('Credits', 200, 0, 70);
        const linear       = word('Linear', 0, 20, 50);
        const algebra      = word('Algebra', 60, 20, 60);
        const and          = word('and', 130, 20, 30);
        const c30          = word('3.0', 200, 20, 30);
        const applications = word('Applications', 0, 40, 110);
        const physics      = word('Physics', 0, 60, 60);
        const c40          = word('4.0', 200, 60, 30);
        const w = [course, credits, linear, algebra, and, c30, applications, physics, c40];
        const csv = [
            ['Course', 'Credits'],
            ['Linear Algebra and Applications', '3.0'],
            ['Physics', '4.0'],
        ];

        const prov = matchCellsToOcr(csv, w, 70);

        expect(prov[1][0].matchStatus).toBe('multi_word');
        expect(prov[1][0].wordIds).toEqual([linear.id, algebra.id, and.id, applications.id]);
        expect(prov[1][1].wordIds).toEqual([c30.id]);
        expect(prov[2][0].wordIds).toEqual([physics.id]);
        expect(prov[2][1].wordIds).toEqual([c40.id]);
    });

    it('keeps a row the OCR dropped unmatched instead of stealing its duplicate from the next row', () => {
        // TSV has two "Widget" rows but OCR only captured the second. The old walk
        // matched the first TSV "Widget" to the only OCR "Widget" (wrong row) and
        // desynced everything after. Grid row alignment assigns the OCR line to the
        // row whose full content agrees ("Widget 7", not "Widget 5").
        const hItem  = word('Item', 0, 0, 40);
        const hQty   = word('Qty', 200, 0, 30);
        const widget = word('Widget', 0, 20, 60);
        const seven  = word('7', 200, 20, 10);
        const w = [hItem, hQty, widget, seven];
        const csv = [['Item', 'Qty'], ['Widget', '5'], ['Widget', '7']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[1][0].matchStatus).toBe('unmatched');
        expect(prov[1][1].matchStatus).toBe('unmatched');
        expect(prov[2][0].wordIds).toEqual([widget.id]);
        expect(prov[2][1].wordIds).toEqual([seven.id]);
    });

    it('skips a full-width title line the model excluded from the table', () => {
        // The title spans the column gap, so no zero-crossing channel exists; the
        // escalating tolerance (k=1) still finds the column split, and the row
        // alignment DP skips the title line rather than forcing it onto row 1.
        const title = word('QuarterlyReport', 10, 0, 220);
        const item  = word('Item', 0, 20, 40);
        const cost  = word('Cost', 200, 20, 40);
        const bolt  = word('Bolt', 0, 40, 40);
        const nine  = word('9', 200, 40, 10);
        const nut   = word('Nut', 0, 60, 30);
        const seven = word('7', 200, 60, 10);
        const w = [title, item, cost, bolt, nine, nut, seven];
        const csv = [['Item', 'Cost'], ['Bolt', '9'], ['Nut', '7']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov.flat().every(c => c.matchStatus === 'matched')).toBe(true);
        expect(prov.flat().every(c => !c.wordIds.includes(title.id))).toBe(true);
        expect(prov[1][0].wordIds).toEqual([bolt.id]);
        expect(prov[2][1].wordIds).toEqual([seven.id]);
    });

    it('resolves a right-justified column whose left edges vary', () => {
        // "112.00" starts left of the header's left edge (right-justified numbers);
        // interval-based channel detection and center-based band assignment place it
        // in the correct column regardless of justification.
        const itemH    = word('Item', 0, 0, 40);
        const costH    = word('Cost', 200, 0, 40);
        const bolt     = word('Bolt', 0, 20, 40);
        const b950     = word('9.50', 210, 20, 40);
        const longname = word('Longname', 0, 40, 80);
        const l112     = word('112.00', 180, 40, 70);
        const w = [itemH, costH, bolt, b950, longname, l112];
        const csv = [['Item', 'Cost'], ['Bolt', '9.50'], ['Longname', '112.00']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov.flat().every(c => c.matchStatus === 'matched')).toBe(true);
        expect(prov[2][1].wordIds).toEqual([l112.id]);
    });

    it('handles empty TSV rows and ragged extra cells without desyncing later rows', () => {
        const name  = word('Name', 0, 0, 40);
        const score = word('Score', 200, 0, 50);
        const ann   = word('Ann', 0, 20, 30);
        const five  = word('5', 200, 20, 10);
        const w = [name, score, ann, five];
        // Middle row is entirely empty; last row has a ragged third cell.
        const csv = [['Name', 'Score'], ['', ''], ['Ann', '5', 'extra']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[1][0].matchStatus).toBe('empty');
        expect(prov[1][0].wordIds).toEqual([]);
        expect(prov[2][0].wordIds).toEqual([ann.id]);
        expect(prov[2][1].wordIds).toEqual([five.id]);
        expect(prov[2][2].matchStatus).toBe('unmatched');
    });

    it('discards a grid that fails to describe the TSV and falls back to the walk', () => {
        // Geometry yields two clean columns, but the TSV merged each visual row's
        // words into column 0 — the grid places nothing, so it is discarded and the
        // reading-order walk (which concatenates across the gap) matches instead.
        const a = word('a', 0, 0, 10);
        const b = word('b', 100, 0, 10);
        const c = word('c', 0, 20, 10);
        const d = word('d', 100, 20, 10);
        const w = [a, b, c, d];
        const csv = [['ab', 'x'], ['cd', 'y']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[0][0].matchStatus).toBe('multi_word');
        expect(prov[0][0].wordIds).toEqual([a.id, b.id]);
        expect(prov[1][0].wordIds).toEqual([c.id, d.id]);
        expect(prov[0][1].matchStatus).toBe('unmatched');
        expect(prov[1][1].matchStatus).toBe('unmatched');
    });
});

describe('matchCellsToOcr — empty cells', () => {
    it('marks blank cells "empty" and keeps the grid alive across an all-empty column', () => {
        // The TSV's middle column is empty in every row (header included), so the
        // image has no ink there and only ONE whitespace channel exists. Demanding
        // a separator for the empty column would kill the grid and hand this table
        // to the walk — which the OCR-dropped duplicate "Widget" row would desync
        // (it would steal the second row's words). Detecting geometry over
        // content-bearing columns only keeps the grid, and its row alignment
        // leaves the dropped row missing.
        const hItem  = word('Item', 0, 0, 40);
        const hQty   = word('Qty', 200, 0, 30);
        const widget = word('Widget', 0, 20, 60);
        const seven  = word('7', 200, 20, 10);
        const w = [hItem, hQty, widget, seven];
        const csv = [['Item', '', 'Qty'], ['Widget', '', '5'], ['Widget', '', '7']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[0][0].wordIds).toEqual([hItem.id]);
        expect(prov[0][2].wordIds).toEqual([hQty.id]);
        expect(prov[1][0].matchStatus).toBe('unmatched'); // dropped row stays missing
        expect(prov[2][0].wordIds).toEqual([widget.id]);
        expect(prov[2][2].wordIds).toEqual([seven.id]);
        // The empty column's cells are "empty" — blank, not failed matches.
        for (const r of [0, 1, 2]) {
            expect(prov[r][1].matchStatus).toBe('empty');
            expect(prov[r][1].wordIds).toEqual([]);
        }
    });

    it('flags an empty cell whose region contains text no cell claimed', () => {
        // The source shows "77" where the model emitted a blank — possible
        // dropped content. The cell stays "empty" but carries the overlooked
        // word's id so the UI can warn and highlight exactly what was skipped.
        const hName  = word('Name', 0, 0, 40);
        const hScore = word('Score', 200, 0, 50);
        const ann    = word('Ann', 0, 20, 30);
        const five   = word('5', 200, 20, 10);
        const bob    = word('Bob', 0, 40, 30);
        const stray  = word('77', 200, 40, 20);
        const w = [hName, hScore, ann, five, bob, stray];
        const csv = [['Name', 'Score'], ['Ann', '5'], ['Bob', '']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[2][1].matchStatus).toBe('empty');
        expect(prov[2][1].wordIds).toEqual([stray.id]);
    });

    it('leaves an empty cell over a genuinely blank region unflagged', () => {
        const hName  = word('Name', 0, 0, 40);
        const hScore = word('Score', 200, 0, 50);
        const ann    = word('Ann', 0, 20, 30);
        const five   = word('5', 200, 20, 10);
        const bob    = word('Bob', 0, 40, 30);
        const w = [hName, hScore, ann, five, bob];
        const csv = [['Name', 'Score'], ['Ann', '5'], ['Bob', '']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[2][1].matchStatus).toBe('empty');
        expect(prov[2][1].wordIds).toEqual([]);
    });

    it('does not flag sub-threshold noise (a stray rule-line glyph) in an empty region', () => {
        // A lone "|" normalizes to nothing, so it can never clear
        // MIN_OVERLOOKED_CHARS — a rule-line artifact is not dropped content.
        const hName  = word('Name', 0, 0, 40);
        const hScore = word('Score', 200, 0, 50);
        const ann    = word('Ann', 0, 20, 30);
        const five   = word('5', 200, 20, 10);
        const bob    = word('Bob', 0, 40, 30);
        const pipe   = word('|', 205, 40, 5);
        const w = [hName, hScore, ann, five, bob, pipe];
        const csv = [['Name', 'Score'], ['Ann', '5'], ['Bob', '']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[2][1].matchStatus).toBe('empty');
        expect(prov[2][1].wordIds).toEqual([]);
    });

    it('flags an all-empty column whose image region contains text (dropped column)', () => {
        // The model emitted an entire column as blanks, but the image has words
        // there. The column has no matched anchor of its own, so its region is
        // bounded by the nearest anchored columns on each side; the unclaimed
        // middle words flag each row's empty cell.
        const hA = word('Alpha', 0, 0, 50);
        const m1 = word('Mid1', 100, 0, 40);
        const hC = word('Gamma', 200, 0, 50);
        const a1 = word('a1', 0, 20, 20);
        const m2 = word('Mid2', 100, 20, 40);
        const c1 = word('c1', 200, 20, 20);
        const w = [hA, m1, hC, a1, m2, c1];
        const csv = [['Alpha', '', 'Gamma'], ['a1', '', 'c1']];

        const prov = matchCellsToOcr(csv, w);

        expect(prov[0][0].wordIds).toEqual([hA.id]);
        expect(prov[1][2].wordIds).toEqual([c1.id]);
        expect(prov[0][1].matchStatus).toBe('empty');
        expect(prov[0][1].wordIds).toEqual([m1.id]);
        expect(prov[1][1].wordIds).toEqual([m2.id]);
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

describe('grounding dispatch', () => {
    // A wrapped cell: "Intro Systems" occupies two visual lines, with "1.00" beside
    // only the first of them. The reading-order walk cannot place it by construction —
    // another column's word is interleaved between its two halves, so no contiguous
    // run of words spells the cell. Only a grid can, which makes this the fixture that
    // tells the three dispatch branches apart.
    const wrapped = () => [
        word('Intro', 0, 0),
        word('1.00', 100, 0),
        word('Systems', 0, 20),
        word('Calc', 0, 100),
        word('2.00', 100, 100),
    ];
    // Words abutting: the columns touch, leaving no whitespace channel between them.
    // `detectColumnSeparators` therefore finds no separator at any tolerance and
    // returns null, so inference yields *no grid at all* on this layout — which is
    // exactly the situation a model-declared grid exists to rescue.
    const abutting = () => [
        word('Intro', 0, 0),
        word('1.00', 10, 0),
        word('Systems', 0, 20),
        word('Calc', 0, 100),
        word('2.00', 10, 100),
    ];
    const TSV = [['Intro Systems', '1.00'], ['Calc', '2.00']];

    // The same layouts as a grounding model would report them: one row band per table
    // row (the first spanning both wrapped lines), one column band per inked column.
    const spacedGrid: DeclaredGrid = {
        rowBands: [{ lo: 0, hi: 35 }, { lo: 95, hi: 115 }],
        colBands: [{ lo: 0, hi: 50 }, { lo: 95, hi: 150 }],
    };
    const tightGrid: DeclaredGrid = {
        rowBands: [{ lo: 0, hi: 35 }, { lo: 95, hi: 115 }],
        colBands: [{ lo: 0, hi: 10 }, { lo: 10, hi: 20 }],
    };

    it('defaults to word grounding, leaving today\'s inferred-grid path untouched', () => {
        const words = wrapped();
        const implicit = matchCellsToOcr(TSV, words, 1000);
        const explicit = matchCellsToOcr(TSV, words, 1000, { grounding: 'word' });
        expect(implicit).toEqual(explicit);
        // With a channel between the columns the grid is inferable, and it solves the
        // wrapped cell — today's behaviour, unchanged.
        expect(implicit[0][0].matchStatus).toBe('multi_word');
    });

    it('places cells a declared grid describes but no inferred grid could', () => {
        // This is the whole point of cell-level grounding. Inference has to find the
        // columns by sweeping for whitespace channels; here there is no channel to
        // find, so it gives up and the walk loses the wrapped cell. The model already
        // knew where the columns were.
        const words = abutting();
        expect(matchCellsToOcr(TSV, words, 1000)[0][0].matchStatus).toBe('unmatched');

        const declared = matchCellsToOcr(TSV, words, 1000, {
            grounding: 'cell',
            grid: tightGrid,
        });
        expect(declared[0][0].matchStatus).toBe('multi_word');
        expect(declared[0][0].wordIds).toEqual([words[0].id, words[2].id]);
        expect(declared[1][1].wordIds).toEqual([words[4].id]);
    });

    it('uses a declared grid with word-precision items — the pairing that ships', () => {
        // Grounding tier and grid source are separate axes, and this is the
        // combination that matters: Tesseract's words (fine boxes, poor column
        // inference) with a model's bands (exact geometry, unreliable text). Keying
        // the declared grid on the `cell` tier would have ruled it out.
        const words = abutting();
        const cells = matchCellsToOcr(TSV, words, 1000, {
            grounding: 'word',
            grid: tightGrid,
        });
        expect(cells[0][0].matchStatus).toBe('multi_word');
        expect(cells[0][0].wordIds).toEqual([words[0].id, words[2].id]);
        // Without the grid the same word-grounded page loses the wrapped cell.
        expect(matchCellsToOcr(TSV, words, 1000)[0][0].matchStatus).toBe('unmatched');
    });

    it('does not infer a grid for block or ungrounded pages', () => {
        // Region boxes have no whitespace channels between words and no visual lines,
        // so inferring column geometry from them would be reading structure out of
        // noise. Both tiers fall to the reading-order walk, and the honest miss on the
        // wrapped cell is what the coarse highlight and the badge then report.
        for (const grounding of ['block', 'none'] as const) {
            const cells = matchCellsToOcr(TSV, wrapped(), 1000, { grounding });
            expect(cells[0][0].matchStatus, grounding).toBe('unmatched');
            // The rest of the table still matches; only the wrapped cell is lost.
            expect(cells[1][0].matchStatus, grounding).toBe('matched');
        }
    });

    it('falls back to inference when a cell-grounded run carries no grid', () => {
        // A grounding step that returned nothing usable must not cost the page its
        // grid — inference is still available, and is what the page would have had.
        const words = wrapped();
        expect(matchCellsToOcr(TSV, words, 1000, { grounding: 'cell' }))
            .toEqual(matchCellsToOcr(TSV, words, 1000));
    });

    it('declines a declared grid whose column count disagrees with the TSV', () => {
        // The model counted the page's columns; the TSV counts the structuring model's
        // own. Mapping them by index when they disagree is a guess, and the two ways it
        // can go wrong are indistinguishable from here: a *trailing* extra band is
        // harmless, while a leading or interleaved one shifts every column by one and
        // matches every cell against its neighbour.
        //
        // This case is the harmless kind — the third band sits past the table, so the
        // identity mapping would have worked — and declining still costs the page its
        // wrapped cell. That is the trade taken deliberately: a grid that silently
        // mismatched a whole table is far worse than one match given up, and nothing
        // available at this point can tell the two shapes apart.
        const words = abutting();
        const threeBands: DeclaredGrid = {
            ...tightGrid,
            colBands: [...tightGrid.colBands, { lo: 200, hi: 250 }],
        };
        const cells = matchCellsToOcr(TSV, words, 1000, { grounding: 'cell', grid: threeBands });
        expect(cells).toEqual(matchCellsToOcr(TSV, words, 1000));
        expect(cells[0][0].matchStatus).toBe('unmatched');
    });

    it('declines a declared grid that covers none of the words', () => {
        const words = wrapped();
        const elsewhere: DeclaredGrid = {
            rowBands: [{ lo: 900, hi: 950 }],
            colBands: [{ lo: 900, hi: 950 }, { lo: 960, hi: 990 }],
        };
        expect(matchCellsToOcr(TSV, words, 1000, { grounding: 'cell', grid: elsewhere }))
            .toEqual(matchCellsToOcr(TSV, words, 1000));
    });

    it('discards a declared grid that does not describe the page, like an inferred one', () => {
        // Bands in the wrong order send every cell looking in its neighbour's column,
        // placing nothing. The same <30% gate that protects the inferred grid catches
        // it, so the page lands on the reading-order walk rather than on a confidently
        // wrong grid — and the three cells the walk can place still come back.
        const words = abutting();
        const swapped: DeclaredGrid = {
            rowBands: tightGrid.rowBands,
            colBands: [tightGrid.colBands[1], tightGrid.colBands[0]],
        };
        const cells = matchCellsToOcr(TSV, words, 1000, { grounding: 'cell', grid: swapped });
        expect(cells[1][0].wordIds).toEqual([words[3].id]);
        expect(cells[0][1].wordIds).toEqual([words[1].id]);
    });

    it('maps an all-empty TSV column to no band, as the inferred path does', () => {
        // An empty column has no ink, so a model reporting a band per inked column
        // reports two, not three. Counting content columns is what makes the two agree
        // — a raw column-count comparison would decline this grid.
        const words = abutting();
        const withGap = TSV.map(([a, b]) => [a, '', b]);
        const cells = matchCellsToOcr(withGap, words, 1000, {
            grounding: 'cell',
            grid: tightGrid,
        });
        expect(cells[0][0].matchStatus).toBe('multi_word');
        expect(cells[0][1].matchStatus).toBe('empty');
        expect(cells[0][2].wordIds).toEqual([words[1].id]);
    });
});
