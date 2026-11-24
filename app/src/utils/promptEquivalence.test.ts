import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { buildTableText } from './ocrTransforms';
import { sanitizeWordsForProvenance } from '../features/extraction/provenance';
import type { OcrWord } from '../features/ocr/types';

/**
 * Golden-file half of the Rust/TypeScript prompt-equivalence check.
 *
 * Stage 1's prompt is derived from the OCR words — sanitized into reading order,
 * then laid out as spatial text — and that derivation is moving into Rust. The two
 * implementations must agree exactly: provenance matches cells against the same
 * word list the model was shown, so a divergence doesn't fail loudly, it quietly
 * mismatches cells and drags the confidence heatmap down with it.
 *
 * Neither side is asserted against the other directly (they can't import each
 * other). Instead both run the same fixture and are pinned to the same golden
 * files: this test writes them, and `pipeline::prompt`'s tests `include_str!` the
 * very same files. Change one implementation and its own test fails; change both
 * compatibly and both pass.
 *
 * Regenerate after an intentional change with `npx vitest run -u promptEquivalence`.
 */

type Fixture = { naturalHeight: number; words: OcrWord[] };

const fixture: Fixture = JSON.parse(
    readFileSync(new URL('../../fixtures/ocr-page.json', import.meta.url), 'utf8'),
);

/**
 * The real Stage 1 composition: sanitize first, then lay out. Chained here in one
 * place because the order matters — laying out the *raw* words would leave rule-line
 * pipe glyphs in the prompt and shift columns relative to what provenance later
 * matches against.
 */
const spatialTextOf = (f: Fixture): string =>
    buildTableText(sanitizeWordsForProvenance(f.words, f.naturalHeight), f.naturalHeight);

describe('prompt derivation — golden files shared with the Rust port', () => {
    it('lays out spatial text', async () => {
        await expect(spatialTextOf(fixture)).toMatchFileSnapshot(
            '../../fixtures/ocr-page.spatial.txt',
        );
    });

    it('sanitizes words into reading order', async () => {
        // Position is included so the file pins the *ordering*, which is what the
        // positional matching walk depends on — not just the surviving text.
        const rendered = sanitizeWordsForProvenance(fixture.words, fixture.naturalHeight)
            .map(w => `${w.text}\t${w.box_coords.left}\t${w.box_coords.top}`)
            .join('\n');
        await expect(rendered).toMatchFileSnapshot('../../fixtures/ocr-page.sanitized.txt');
    });

    /**
     * The fixture earns its keep only if it actually exercises the traps. If a
     * future edit waters it down, the equivalence tests would still pass while
     * testing nothing interesting — so assert the hazards are present.
     */
    it('covers the cases the two implementations are most likely to diverge on', () => {
        const spatial = spatialTextOf(fixture);

        // A cell whose UTF-16 length (6) differs from its UTF-8 byte length (7).
        // Byte-based padding on the Rust side shifts every later column by one.
        const nonAscii = fixture.words.find(w => w.text === 'Crédit');
        expect(nonAscii).toBeDefined();
        expect(nonAscii!.text.length).toBe(6);
        expect(Buffer.byteLength(nonAscii!.text, 'utf8')).toBe(7);

        // The centred title must not be chosen as the column anchor line: if it
        // were, every row would collapse into one column.
        expect(spatial.split('\n')).toHaveLength(5);
        expect(spatial).toContain('Description');

        // A department code and course number separated by a small gap stay in one
        // column rather than splitting into two.
        expect(spatial).toContain('BUSINESS 1299E');

        // Pipe glyphs: stripped when they wrap real text, kept when they are the
        // whole word (an OCR misread of "I" the model may still resolve).
        const sanitized = sanitizeWordsForProvenance(fixture.words, fixture.naturalHeight);
        expect(sanitized.map(w => w.text)).toContain('Calc');
        expect(sanitized.map(w => w.text)).toContain('||');
    });
});
