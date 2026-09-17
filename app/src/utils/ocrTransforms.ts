import type { OcrWord } from '../features/ocr/types';
import type { LineWord } from '../features/extraction/types';

const lineThreshold = (imageHeight: number) => Math.max(2, imageHeight * 0.005);

/**
 * Cluster words into reading-order lines, then sort each line left-to-right.
 *
 * This is the single source of truth for line grouping — `sortWords`,
 * `buildTableText`, and `generateLinesFromWords` all build on it so the three
 * never drift apart (previously each rolled its own threshold logic).
 *
 * The clustering is a single pass over top-sorted words carrying a running
 * anchor: a word opens a new line only when its `top` is more than `threshold`
 * below the *previous* word's `top` (a gap), not below the line's first word.
 * This is transitive — unlike a pairwise "is A within threshold of B" comparator,
 * which is not a valid sort order (for A≈B, B≈C, A≉C it contradicts itself) and
 * let noisy / slightly-tilted scans scramble reading order.
 *
 * Why gap-to-previous and not anchor-to-first: on low-resolution scans the
 * threshold is only a few pixels, and a single visual row can still drift more
 * than that across its width (slight tilt, or digits sitting a hair lower than
 * the caps beside them). Anchoring to the first word caps a line's vertical
 * span at `threshold` and exiles such a word to the next line — which reorders
 * it relative to its row and silently desyncs the provenance cursor walk (e.g.
 * a course number landing after its description instead of beside its code).
 * Comparing to the previous word lets the line follow the drift, while the large
 * gap between real rows still splits them.
 */
export const groupWordsIntoLines = (words: OcrWord[], imageHeight: number): OcrWord[][] => {
    if (words.length === 0) return [];
    const threshold = lineThreshold(imageHeight);

    const byTop = [...words].sort((a, b) => a.box_coords.top - b.box_coords.top);

    const lines: OcrWord[][] = [];
    let currentLine: OcrWord[] = [byTop[0]];
    let prevTop = byTop[0].box_coords.top;

    for (let i = 1; i < byTop.length; i++) {
        const w = byTop[i];
        // byTop is ascending, so the gap from the previous word is always >= 0.
        if (w.box_coords.top - prevTop > threshold) {
            lines.push(currentLine);
            currentLine = [w];
        } else {
            currentLine.push(w);
        }
        prevTop = w.box_coords.top;
    }
    lines.push(currentLine);

    for (const line of lines) {
        line.sort((a, b) => a.box_coords.left - b.box_coords.left);
    }
    return lines;
};

/**
 * The column starts a single line implies: a gap wider than `columnGap` between
 * one word's right edge and the next word's left edge opens a new column, while
 * smaller gaps keep a multi-word heading ("Course Number") in one column.
 */
const columnAnchorsOf = (line: OcrWord[], columnGap: number): number[] => {
    const anchors: number[] = [];
    let prevRight = -Infinity;
    for (const w of line) {
        if (w.box_coords.left - prevRight > columnGap) {
            anchors.push(w.box_coords.left);
        }
        prevRight = w.box_coords.left + w.box_coords.width;
    }
    return anchors;
};

/**
 * Pick the line whose column starts best describe the whole page.
 *
 * The anchor line used to be `lineGroups[0]` outright, which assumed the first
 * visual line is the header row. Scanned documents routinely lead with a title,
 * a date or a page number: a single centred word yields exactly one anchor, and
 * every row of the prompt text then collapses into one column — silently
 * degrading the Stage 1 prompt for a whole class of real inputs, with no signal
 * that it happened.
 *
 * Rather than special-casing a title, this leans on the same property the
 * pin-to-one-line design already rests on: *real columns are vertically
 * consistent*. A candidate's anchor is "corroborated" when some other line also
 * starts a word there, so a line is scored by how many of its column starts the
 * rest of the page agrees with. A title's lone anchor scores 1 at best; the
 * header of a four-column table scores 4. Ties go to the earliest line, which
 * keeps the header winning over identically-structured body rows and leaves
 * well-formed documents rendering exactly as before.
 *
 * Corroboration (not just "most columns") is what stops a noisy line — an
 * over-segmented word, speckle read as characters — from being chosen for
 * having the most gaps in it.
 */
const chooseAnchorLine = (lineGroups: OcrWord[][], columnGap: number, tolerance: number): OcrWord[] => {
    let best = lineGroups[0];
    let bestScore = -1;

    for (const candidate of lineGroups) {
        const anchors = columnAnchorsOf(candidate, columnGap);
        const score = anchors.filter(anchor =>
            lineGroups.some(other =>
                other !== candidate &&
                other.some(w => Math.abs(w.box_coords.left - anchor) <= tolerance),
            ),
        ).length;
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
};

/**
 * Rebuild spatially-accurate text from the structured words array.
 *
 * **Not dead code, despite having no runtime caller.** Prompt building moved to
 * Rust (`src-tauri/src/pipeline/prompt.rs`); this is the reference the port is held
 * against. `promptEquivalence.test.ts` runs it over the shared fixture to write the
 * golden files that the Rust tests then assert against, so deleting it would leave
 * the port's byte-for-byte fidelity claim resting on nothing. Keep the two in step.
 *
 * Column boundaries are derived once from a single representative line (see
 * `chooseAnchorLine`) and every row is snapped to those columns. Real columns
 * are vertically consistent across rows, whereas a wide cell holding left- and
 * right-justified content is not — so pinning each row to one line's columns
 * prevents that within-cell gap from being mistaken for a column break (which
 * previously spawned a phantom, unnamed trailing column). Within a column,
 * words are joined with a single space.
 */
export const buildTableText = (words: OcrWord[], naturalHeight: number): string => {
    if (words.length === 0) return '';

    // Derive a pixels-per-character scale from the word boxes themselves.
    let totalPx = 0, totalChars = 0;
    for (const w of words) {
        if (w.text.length > 0 && w.box_coords.width > 0) {
            totalPx += w.box_coords.width;
            totalChars += w.text.length;
        }
    }
    const avgCharWidth = totalChars > 0 ? totalPx / totalChars : 8;

    const lineGroups = groupWordsIntoLines(words, naturalHeight);

    // Derive canonical column anchors (pixel left edges) from the most
    // representative line. A gap wider than ~3 spaces between its words starts a
    // new column; smaller gaps keep multi-word headers ("Course Number") in one.
    // The corroboration tolerance is one character: scanned columns are aligned
    // to within a character's width, not to the pixel.
    const columnGap = avgCharWidth * 3;
    const headerLine = chooseAnchorLine(lineGroups, columnGap, avgCharWidth);
    const anchors = columnAnchorsOf(headerLine, columnGap);
    if (anchors.length === 0) anchors.push(headerLine[0].box_coords.left);

    // The column a word belongs to: the rightmost anchor at or left of the word.
    // A word that sits between two anchors (e.g. right-justified content in a wide
    // cell) maps to the left column rather than spilling into the next one.
    const columnOf = (left: number): number => {
        let col = 0;
        for (let c = 1; c < anchors.length; c++) {
            if (left + avgCharWidth * 0.5 >= anchors[c]) col = c;
            else break;
        }
        return col;
    };

    return lineGroups.map(line => {
        // Bucket words into header columns, joining intra-column words with a space.
        const cells: string[] = new Array(anchors.length).fill('');
        for (const word of line) {
            const c = columnOf(word.box_coords.left);
            cells[c] = cells[c] ? `${cells[c]} ${word.text}` : word.text;
        }

        // Render cells padded to each column's character anchor.
        let result = '';
        for (let c = 0; c < anchors.length; c++) {
            if (!cells[c]) continue;
            const targetCol = Math.round(anchors[c] / avgCharWidth);
            if (targetCol > result.length) {
                result += ' '.repeat(targetCol - result.length);
            } else if (result.length > 0) {
                result += ' ';
            }
            result += cells[c];
        }
        return result;
    }).join('\n');
};

export const generateLinesFromWords = (words: OcrWord[], imageHeight: number): LineWord[][] =>
    groupWordsIntoLines(words, imageHeight).map(line =>
        line.map(word => ({ text: word.text, wordId: word.id }))
    );

/**
 * Plain reading-order text: lines top-to-bottom, words left-to-right, one line
 * per row. This is what `document_pages.full_text` holds and what content search
 * matches against.
 *
 * It is the single builder for that string. The value used to be written two
 * different ways: the initial insert stored Tesseract's raw `image_to_data`
 * output — the TSV *data table*, header row and all, not readable text — and
 * only a subsequent word edit replaced it with real text. Nothing read the
 * column back then, so it was harmless; the moment search started matching on
 * it, half the corpus would have been TSV field names.
 */
export const buildReadingOrderText = (words: OcrWord[], imageHeight: number): string =>
    groupWordsIntoLines(words, imageHeight)
        .map(line => line.map(word => word.text).join(' '))
        .join('\n');

// Reading order: lines top-to-bottom, words left-to-right within each line.
export const sortWords = (words: OcrWord[], imageHeight: number): OcrWord[] =>
    groupWordsIntoLines(words, imageHeight).flat();
