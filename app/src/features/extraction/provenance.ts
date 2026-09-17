import type { OcrWord, BoundingBox } from '../ocr/types';
import { sortWords, groupWordsIntoLines } from '../../utils/ocrTransforms';
import { blankCell } from './tableEdits';
import type { CellProvenance, DeclaredGrid, GroundingKind, ProvenanceCell, Span } from './types';

export const normalize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Sort words into reading order, strip column-rule pipe glyphs, drop empties.
// Each word keeps its stable `id` (UUID) — that id, not the array position, is
// what CellProvenance.wordIds stores, so a later add/edit/delete that reorders
// the array can't mis-resolve a stored mapping.
// Must be called before matching — the positional walk below is relative to the
// order this produces, but only UUIDs survive into the stored provenance.
// Words whose entire text is pipe glyphs (e.g. OCR misread of "I" as "|") are kept with
// their original text so the LLM can cross-reference the image; they will be unmatched by
// provenance and surface as "image_only" / ? badge rather than silently dropped.
export const sanitizeWordsForProvenance = (words: OcrWord[], naturalHeight: number): OcrWord[] =>
    sortWords(words, naturalHeight)
        .map(w => {
            const stripped = w.text.replace(/^\|+|\|+$/g, "").trim();
            return stripped.length > 0 ? { ...w, text: stripped } : w;
        })
        .filter(w => w.text.length > 0);

// The model may omit trailing empty cells from a TSV row entirely (no trailing
// tab), leaving the parsed grid ragged — most visibly, an empty bottom-right
// cell simply doesn't exist, so the table renders without it. Pad every short
// row to the grid's widest row with synthetic empty cells (same shape/confidence
// computeProvenanceCells gives a clean empty cell) so the table is always
// rectangular. Applied at the state boundary, so it also repairs ragged grids
// persisted by earlier versions. Returns the input untouched when already
// rectangular.
export const padProvenanceGrid = (rows: ProvenanceCell[][]): ProvenanceCell[][] => {
    const width = rows.reduce((w, row) => Math.max(w, row.length), 0);
    if (rows.every(row => row.length === width)) return rows;
    return rows.map((row, r) =>
        row.length === width ? row : [
            ...row,
            ...Array.from({ length: width - row.length }, (_, i) => blankCell(r, row.length + i)),
        ]);
};

const unionBoxes = (boxes: BoundingBox[]): BoundingBox => {
    const left   = Math.min(...boxes.map(b => b.left));
    const top    = Math.min(...boxes.map(b => b.top));
    const right  = Math.max(...boxes.map(b => b.left + b.width));
    const bottom = Math.max(...boxes.map(b => b.top + b.height));
    return { left, top, width: right - left, height: bottom - top };
};

// Returns the union bounding box for a cell's source words, or null if unmatched.
//
// `wordIds` are stable OcrWord UUIDs, resolved against the *current* word array
// at click time. Because they are identities rather than positions, an add/edit
// elsewhere on the page no longer shifts a cell onto the wrong box. If a word a
// cell mapped to was since deleted its id won't resolve — we return null (no
// highlight) rather than a misleading partial box or a throw that blanks the pane.
export const getCellSourceBox = (prov: CellProvenance, ocrWords: OcrWord[]): BoundingBox | null => {
    if (prov.wordIds.length === 0) return null;
    const byId = new Map(ocrWords.map(w => [w.id, w]));
    const boxes: BoundingBox[] = [];
    for (const id of prov.wordIds) {
        const word = byId.get(id);
        if (!word) return null;
        boxes.push(word.box_coords);
    }
    return unionBoxes(boxes);
};

// Bounded lookahead window — keeps duplicate-value disambiguation correct.
// Tune upward if OCR/CSV ordering drift exceeds one row span.
const WINDOW = 12;

const range = (start: number, last: number): number[] =>
    Array.from({ length: last - start + 1 }, (_, i) => start + i);

function matchFromCursor(
    ocrWords: OcrWord[],
    cursor: number,
    target: string,
): { ids: number[]; nextCursor: number } | null {
    if (!target) return null;
    const end = Math.min(ocrWords.length, cursor + WINDOW);

    for (let start = cursor; start < end; start++) {
        let concat = "";
        for (let last = start; last < end; last++) {
            concat += normalize(ocrWords[last].text);
            if (concat === target) {
                return { ids: range(start, last), nextCursor: last + 1 };
            }
            if (concat.length > target.length) break;
        }
    }
    return null;
}

// Levenshtein edit distance between two normalized strings (rolling two-row DP).
export function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array<number>(n + 1);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

// 0–1 similarity; 1 means identical. Used to judge near-miss OCR reads.
export const similarity = (a: string, b: string): number => {
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
};

// Minimum similarity for a fuzzy match to count. 0.8 tolerates a handful of
// glyph misreads (e.g. "I" -> "|", "0" -> "O") without matching unrelated text.
const FUZZY_THRESHOLD = 0.8;

// Internal working cell — carries *positional* indices into the sanitized word
// array while the matcher runs. Converted to stable UUIDs only when the public
// CellProvenance is emitted.
type WorkingCell = {
    rowIndex: number;
    colIndex: number;
    value: string;
    wordIdx: number[];
    matchStatus: CellProvenance['matchStatus'];
};

// Best contiguous run of candidate words whose normalized concatenation is most
// similar to target, provided it clears FUZZY_THRESHOLD. Candidates must be in
// reading order; every matching pass funnels through this so the acceptance bar
// is identical everywhere.
function bestRunMatch(
    ocrWords: OcrWord[],
    candidates: number[],
    target: string,
): { ids: number[]; similarity: number } | null {
    if (!target || candidates.length === 0) return null;
    const maxConcat = Math.ceil(target.length * 1.5) + 2;

    let best: { ids: number[]; similarity: number } | null = null;
    for (let start = 0; start < candidates.length; start++) {
        let concat = "";
        for (let last = start; last < candidates.length; last++) {
            concat += normalize(ocrWords[candidates[last]].text);
            if (concat.length > maxConcat) break;
            const sim = similarity(concat, target);
            if (sim >= FUZZY_THRESHOLD && (!best || sim > best.similarity)) {
                best = { ids: candidates.slice(start, last + 1), similarity: sim };
            }
        }
    }
    return best;
}

// A perfect (1.0) hit is a real match; anything below stays "fuzzy" so the
// confidence stage can knock its trust down one level.
function applyRunMatch(
    cell: WorkingCell,
    best: { ids: number[]; similarity: number },
    claimed: Set<number>,
): void {
    cell.wordIdx = best.ids;
    cell.matchStatus = best.similarity >= 1
        ? (best.ids.length > 1 ? "multi_word" : "matched")
        : "fuzzy";
    for (const i of best.ids) claimed.add(i);
}

// ── Grid-first spatial matching (primary pass) ──────────────────────────────
//
// The reading-order walk assumes TSV cell order tracks OCR reading order. A
// wrapped (multi-line) cell breaks that — its words are interleaved with other
// columns' words across two visual lines, so no contiguous run can ever match —
// and a row the OCR dropped lets a duplicate value from the next row be stolen,
// desyncing everything after it. The grid matcher removes the assumption:
//   1. Column bands are detected from word geometry (whitespace channels).
//   2. TSV rows are aligned to visual lines by content (DP), so a row may span
//      several wrapped lines, noise lines are skipped, and missing rows stay
//      missing instead of stealing the next row's words.
//   3. Each cell matches only against unclaimed words inside its own
//      row × column region.
// Row/line boundaries are deliberately *not* inferred from vertical gaps alone:
// a wrapped-line boundary is geometrically indistinguishable from a row
// boundary in a densely-spaced table, so content has to arbitrate.

// Inclusive range of visual lines a TSV row occupies.
type RowRange = { start: number; end: number };

type TableGrid = {
    lines: number[][];              // word indices per visual line, reading order
    wordCol: number[];              // column *band* index per word, parallel to ocrWords
    // TSV column index -> detected band index; -1 for an all-empty TSV column,
    // which has no ink in the image and therefore no band of its own.
    colToBand: number[];
    rowRanges: (RowRange | null)[]; // per TSV row; null = row absent from OCR
};

// A TSV row may wrap over at most this many visual lines.
const MAX_ROW_SPAN = 5;
// Minimum content similarity for a TSV row to claim a span of lines. Below this
// the DP prefers marking the row missing over a garbage alignment.
const MIN_ROW_SIM = 0.3;
// DP penalties: skipping a visual line (title/footnote noise) and leaving a TSV
// row with no lines (OCR dropped it). Both small relative to a real match's
// +similarity, so genuine alignments always dominate.
const LINE_SKIP_PENALTY = -0.15;
const ROW_MISS_PENALTY = -0.1;
// If the grid places fewer than this fraction of non-empty cells, the detected
// grid didn't actually describe the TSV (e.g. the model restructured columns) —
// discard it and fall back to the reading-order walk.
const MIN_GRID_MATCH_FRACTION = 0.3;

// The TSV's own column count anchors column detection — mode of row lengths, so
// one ragged row can't distort it.
function expectedColumnCount(csvRows: string[][]): number {
    const freq = new Map<number, number>();
    for (const row of csvRows) freq.set(row.length, (freq.get(row.length) ?? 0) + 1);
    let best = 0, bestN = 0;
    for (const [len, n] of freq) {
        if (n > bestN || (n === bestN && len > best)) { best = len; bestN = n; }
    }
    return best;
}

// Detect column separator x-positions as whitespace channels: x-intervals that
// no (or almost no) word box crosses over the table's full height. Channels are
// justification-agnostic — left-, right- or center-justified cell content all
// lives inside its band, and the channel is the gap between bands. The crossing
// tolerance k escalates from 0 so a stray full-width line (a title, or an OCR
// word merged across a rule) can't erase a real column gap; the expected count
// comes from the TSV itself, and the widest channels win when there are extras
// (an aligned intra-cell space can open a narrow accidental channel).
function detectColumnSeparators(
    ocrWords: OcrWord[],
    columnCount: number,
    lineCount: number,
): number[] | null {
    let minLeft = Infinity, maxRight = -Infinity;
    let totalPx = 0, totalChars = 0;
    const events: { x: number; d: number }[] = [];
    for (const w of ocrWords) {
        const l = w.box_coords.left, r = l + w.box_coords.width;
        events.push({ x: l, d: 1 }, { x: r, d: -1 });
        minLeft = Math.min(minLeft, l);
        maxRight = Math.max(maxRight, r);
        if (w.text.length > 0 && w.box_coords.width > 0) {
            totalPx += w.box_coords.width;
            totalChars += w.text.length;
        }
    }
    const avgCharWidth = totalChars > 0 ? totalPx / totalChars : 8;
    // Narrower than half a character is an artifact, not a column gap.
    const minGap = Math.max(2, avgCharWidth * 0.5);
    events.sort((a, b) => a.x - b.x);

    const kMax = Math.max(1, Math.floor(lineCount * 0.2));
    for (let k = 0; k <= kMax; k++) {
        // Sweep the x-axis; a channel is a maximal interval where at most k word
        // boxes overlap. All events at the same x are folded before evaluating,
        // so an abutting end/start pair can't open a phantom channel.
        const channels: { lo: number; hi: number }[] = [];
        let cov = 0;
        let openStart: number | null = null;
        let i = 0;
        while (i < events.length) {
            const x = events[i].x;
            while (i < events.length && events[i].x === x) { cov += events[i].d; i++; }
            if (cov <= k && openStart === null) {
                openStart = x;
            } else if (cov > k && openStart !== null) {
                channels.push({ lo: openStart, hi: x });
                openStart = null;
            }
        }
        // A region still open at the end starts at maxRight (outside the table)
        // and is dropped, as is anything hugging the outer extents.
        const inside = channels.filter(ch =>
            ch.lo > minLeft && ch.hi < maxRight && ch.hi - ch.lo >= minGap);
        if (inside.length >= columnCount - 1) {
            return inside
                .sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo))
                .slice(0, columnCount - 1)
                .map(ch => (ch.lo + ch.hi) / 2)
                .sort((a, b) => a - b);
        }
    }
    return null;
}

// Align TSV rows to visual lines by content (Needleman–Wunsch-style DP).
// A row may consume 1..MAX_ROW_SPAN consecutive lines (wrapped cells), a line
// may be skipped (noise the model excluded), and a row may consume no lines
// (OCR dropped it). Span similarity is computed per column band — words are
// bucketed by band and concatenated across the span — which un-interleaves
// wrapped content so a two-line row still scores ~1.0 against its cells.
// All-empty TSV columns have no band (colToBand -1) and are simply absent from
// the comparison — they contribute no text on either side.
function alignRowsToLines(
    csvRows: string[][],
    lines: number[][],
    wordCol: number[],
    bandCount: number,
    colToBand: number[],
    ocrWords: OcrWord[],
): (RowRange | null)[] {
    const R = csvRows.length, L = lines.length;

    const lineColText: string[][] = lines.map(line => {
        const cols = new Array<string>(bandCount).fill("");
        for (const i of line) cols[wordCol[i]] += normalize(ocrWords[i].text);
        return cols;
    });
    const rowNorm: string[][] = csvRows.map(row => {
        const cols = new Array<string>(bandCount).fill("");
        for (let c = 0; c < row.length; c++) {
            const band = colToBand[c] ?? -1;
            if (band >= 0) cols[band] += normalize(row[c]);
        }
        return cols;
    });

    // Length-weighted mean per-column similarity between a TSV row and the
    // words in lines [startLine, endLine]. Columns empty on both sides carry no
    // weight (an empty cell over an empty band is agreement, not evidence).
    const rowSim = (r: number, startLine: number, endLine: number): number => {
        const combined = new Array<string>(bandCount).fill("");
        for (let l = startLine; l <= endLine; l++) {
            for (let c = 0; c < bandCount; c++) combined[c] += lineColText[l][c];
        }
        let num = 0, den = 0;
        for (let c = 0; c < bandCount; c++) {
            const a = rowNorm[r][c], b = combined[c];
            const w = Math.max(a.length, b.length);
            if (w === 0) continue;
            num += similarity(a, b) * w;
            den += w;
        }
        return den === 0 ? 0 : num / den;
    };

    // score[r][l]: best total aligning the first r rows to the first l lines.
    // choice: SKIP (line unassigned) | MISS (row got nothing) | s>0 (row took s lines).
    const SKIP = -1, MISS = -2;
    const score: number[][] = Array.from({ length: R + 1 }, () => new Array<number>(L + 1).fill(0));
    const choice: number[][] = Array.from({ length: R + 1 }, () => new Array<number>(L + 1).fill(SKIP));
    for (let l = 1; l <= L; l++) score[0][l] = score[0][l - 1] + LINE_SKIP_PENALTY;
    for (let r = 1; r <= R; r++) {
        score[r][0] = score[r - 1][0] + ROW_MISS_PENALTY;
        choice[r][0] = MISS;
    }
    for (let r = 1; r <= R; r++) {
        for (let l = 1; l <= L; l++) {
            let best = score[r][l - 1] + LINE_SKIP_PENALTY;
            let ch = SKIP;
            const miss = score[r - 1][l] + ROW_MISS_PENALTY;
            if (miss > best) { best = miss; ch = MISS; }
            for (let s = 1; s <= Math.min(MAX_ROW_SPAN, l); s++) {
                const sim = rowSim(r - 1, l - s, l - 1);
                if (sim < MIN_ROW_SIM) continue;
                const val = score[r - 1][l - s] + sim;
                if (val > best) { best = val; ch = s; }
            }
            score[r][l] = best;
            choice[r][l] = ch;
        }
    }

    const ranges: (RowRange | null)[] = new Array(R).fill(null);
    let r = R, l = L;
    while (r > 0 || l > 0) {
        const ch = choice[r][l];
        if (ch === SKIP) {
            l--;
        } else if (ch === MISS) {
            r--;
        } else {
            ranges[r - 1] = { start: l - ch, end: l - 1 };
            r--;
            l -= ch;
        }
    }
    return ranges;
}

// Map TSV columns onto column bands.
//
// An all-empty TSV column has no ink in the image, so its band and the two gaps
// flanking it merge into a single whitespace channel — demanding a separator for it
// would fail detection (or promote an accidental channel) and cost the whole table its
// grid. Geometry is therefore matched over content-bearing columns only; empty columns
// keep their TSV index but map to no band (their cells have nothing to match anyway).
//
// Shared by both grid sources on purpose: a declared grid describes the same page, so
// a model that reports a band per *inked* column has to line up against the same
// filtered list the inferred path builds.
function mapContentColumnsToBands(
    csvRows: string[][],
    columnCount: number,
): { colToBand: number[]; bandCount: number } {
    const hasContent = new Array<boolean>(columnCount).fill(false);
    for (const row of csvRows) {
        const n = Math.min(row.length, columnCount);
        for (let c = 0; c < n; c++) {
            if (!hasContent[c] && normalize(row[c])) hasContent[c] = true;
        }
    }
    const colToBand: number[] = new Array(columnCount).fill(-1);
    let bandCount = 0;
    for (let c = 0; c < columnCount; c++) {
        if (hasContent[c]) colToBand[c] = bandCount++;
    }
    return { colToBand, bandCount };
}

const bandIndexAt = (v: number, bands: Span[]): number =>
    bands.findIndex(b => v >= b.lo && v <= b.hi);

// Build the grid from bands a grounding model declared, instead of inferring it.
//
// This is the whole point of cell-level grounding. The inferred path has to guess
// twice: `detectColumnSeparators` sweeps for whitespace channels, and
// `groupWordsIntoLines` splits rows on vertical gaps. Both are geometry heuristics,
// and between them they account for every Provenance/Matching post-mortem in
// `docs/issues.md` ("everything loses alignment if the OCR isn't perfect"). A model
// that reports Row and Col bands has already answered both questions.
//
// What is deliberately *not* taken from the model is which TSV row corresponds to
// which band. `alignRowsToLines` still arbitrates that by content, because the bands
// describe the page while the TSV describes what the structuring model made of it, and
// those can legitimately differ — a dropped row, a merged header. Geometry from the
// model, alignment from the content, is the division that degrades gracefully.
//
// Returns null when the declared bands cannot describe this TSV, so the caller can
// fall back to inference rather than matching against a grid that doesn't fit.
function buildDeclaredTableGrid(
    csvRows: string[][],
    ocrWords: OcrWord[],
    declared: DeclaredGrid,
): TableGrid | null {
    if (csvRows.length === 0 || ocrWords.length === 0) return null;
    const { rowBands, colBands } = declared;
    if (rowBands.length === 0 || colBands.length < 2) return null;

    const columnCount = expectedColumnCount(csvRows);
    if (columnCount < 2) return null;
    const { colToBand, bandCount } = mapContentColumnsToBands(csvRows, columnCount);
    // The model counted the page's columns; the TSV counts the structuring model's
    // own. Mapping them by index when they disagree is a guess, and the two ways it
    // can go wrong are indistinguishable from here: a trailing extra band is harmless,
    // while a leading or interleaved one shifts every column by one and matches every
    // cell against its neighbour. Declining costs a page that had the harmless shape
    // whatever the declared grid would have bought it — the cheaper mistake by far.
    if (bandCount !== colBands.length) return null;

    // Words resolve by box center, exactly as the inferred path does, so a word
    // straddling a band edge belongs to whichever side holds its middle.
    const wordCol = ocrWords.map(w =>
        bandIndexAt(w.box_coords.left + w.box_coords.width / 2, colBands));
    const wordRow = ocrWords.map(w =>
        bandIndexAt(w.box_coords.top + w.box_coords.height / 2, rowBands));

    // One "line" per declared row band, in the reading order sanitization produced.
    // A word outside every band — marginalia, a stamp, a footnote below the table —
    // joins no line and is simply left to the recovery passes.
    const lines: number[][] = rowBands.map(() => []);
    for (let i = 0; i < ocrWords.length; i++) {
        if (wordRow[i] >= 0 && wordCol[i] >= 0) lines[wordRow[i]].push(i);
    }
    if (lines.every(line => line.length === 0)) return null;

    const rowRanges = alignRowsToLines(csvRows, lines, wordCol, bandCount, colToBand, ocrWords);
    return { lines, wordCol, colToBand, rowRanges };
}

function detectTableGrid(
    csvRows: string[][],
    ocrWords: OcrWord[],
    naturalHeight?: number,
): TableGrid | null {
    if (csvRows.length === 0 || ocrWords.length === 0) return null;
    const columnCount = expectedColumnCount(csvRows);
    // A single-column table has no geometry to exploit — the walk handles it.
    if (columnCount < 2) return null;

    const { colToBand, bandCount } = mapContentColumnsToBands(csvRows, columnCount);
    if (bandCount < 2) return null;

    // Reuse the canonical line grouping so the grid can never disagree with the
    // reading order sanitizeWordsForProvenance produced. When the caller has no
    // image height handy, the words' own extent gives the same ~0.5% threshold.
    const height = naturalHeight
        ?? Math.max(...ocrWords.map(w => w.box_coords.top + w.box_coords.height));
    const idxOf = new Map(ocrWords.map((w, i) => [w.id, i]));
    const lines = groupWordsIntoLines(ocrWords, height)
        .map(line => line.map(w => idxOf.get(w.id)!));

    const separators = detectColumnSeparators(ocrWords, bandCount, lines.length);
    if (!separators) return null;

    // A word belongs to the column band its horizontal center falls in, so
    // left-, right- and center-justified cell content all resolve identically.
    const wordCol = ocrWords.map(w => {
        const cx = w.box_coords.left + w.box_coords.width / 2;
        let col = 0;
        for (const s of separators) { if (cx > s) col++; }
        return col;
    });

    const rowRanges = alignRowsToLines(csvRows, lines, wordCol, bandCount, colToBand, ocrWords);
    return { lines, wordCol, colToBand, rowRanges };
}

// Primary pass: match each cell against the unclaimed OCR words inside its own
// row × column region. Duplicates disambiguate by *position* (their grid cell),
// not sequence, and an empty cell simply has no candidates — neither can desync
// any other cell.
function gridMatchCells(
    working: WorkingCell[][],
    ocrWords: OcrWord[],
    grid: TableGrid,
    claimed: Set<number>,
): void {
    for (let r = 0; r < working.length; r++) {
        const rowRange = grid.rowRanges[r];
        if (!rowRange) continue;
        for (const cell of working[r]) {
            const target = normalize(cell.value);
            const band = grid.colToBand[cell.colIndex] ?? -1;
            if (!target || band < 0) continue;

            const candidates: number[] = [];
            for (let l = rowRange.start; l <= rowRange.end; l++) {
                for (const i of grid.lines[l]) {
                    if (grid.wordCol[i] === band && !claimed.has(i)) candidates.push(i);
                }
            }
            const best = bestRunMatch(ocrWords, candidates, target);
            if (best) applyRunMatch(cell, best, claimed);
        }
    }
}

// Fraction of non-empty cells the grid placed — the accept/discard gate.
function matchedFraction(working: WorkingCell[][]): number {
    let matched = 0, total = 0;
    for (const row of working) {
        for (const cell of row) {
            if (!normalize(cell.value)) continue;
            total++;
            if (cell.matchStatus !== "unmatched") matched++;
        }
    }
    return total === 0 ? 0 : matched / total;
}

// ── Fallback + recovery passes ───────────────────────────────────────────────

// Fallback primary pass: parallel reading-order walk over cells and words.
// Cursor advances only on a match, so one unmatched cell cannot desync the rest.
// Used when no grid is detectable (non-tabular layout, single column) or the
// detected grid failed to describe the TSV.
function sequenceWalkPass(
    working: WorkingCell[][],
    ocrWords: OcrWord[],
    claimed: Set<number>,
): void {
    let cursor = 0;
    for (const row of working) {
        for (const cell of row) {
            const match = matchFromCursor(ocrWords, cursor, normalize(cell.value));
            if (match) {
                cursor = match.nextCursor;
                cell.wordIdx = match.ids;
                cell.matchStatus = match.ids.length > 1 ? "multi_word" : "matched";
                for (const i of match.ids) claimed.add(i);
            }
        }
    }
}

// Recovery pass: for cells still unmatched, search the positional gap between
// their nearest matched neighbours (in reading order) for a close OCR run.
// After the walk the bounds alone prevent stealing; after the grid pass matched
// indices are no longer monotonic, so an inverted gap simply yields no
// candidates and the claimed-set keeps placed words safe either way.
function fuzzyMatchPass(
    result: WorkingCell[][],
    ocrWords: OcrWord[],
    claimed: Set<number>,
): void {
    const flat = result.flat();
    for (let i = 0; i < flat.length; i++) {
        const cell = flat[i];
        if (cell.matchStatus !== "unmatched") continue;
        const target = normalize(cell.value);
        if (!target) continue;

        let lo = 0;
        for (let j = i - 1; j >= 0; j--) {
            if (flat[j].wordIdx.length > 0) { lo = Math.max(...flat[j].wordIdx) + 1; break; }
        }
        let hi = ocrWords.length;
        for (let j = i + 1; j < flat.length; j++) {
            if (flat[j].wordIdx.length > 0) { hi = Math.min(...flat[j].wordIdx); break; }
        }

        const candidates: number[] = [];
        for (let w = lo; w < hi; w++) {
            if (!claimed.has(w)) candidates.push(w);
        }
        const best = bestRunMatch(ocrWords, candidates, target);
        if (best) applyRunMatch(cell, best, claimed);
    }
}

// `Span` (an inclusive 1-D interval) is shared with the declared-grid types — it is
// the same thing whether the band was derived from cells the earlier passes placed or
// handed over by a grounding model.

// y-span (top→bottom) covering every OCR word the given cells matched, or null if
// none of them matched. Used as a row band.
function verticalSpan(cells: WorkingCell[], ocrWords: OcrWord[]): Span | null {
    let lo = Infinity, hi = -Infinity;
    for (const cell of cells) {
        for (const i of cell.wordIdx) {
            const b = ocrWords[i].box_coords;
            lo = Math.min(lo, b.top);
            hi = Math.max(hi, b.top + b.height);
        }
    }
    return lo <= hi ? { lo, hi } : null;
}

// x-span (left→right) covering every OCR word the given cells matched, or null.
// Used as a column band.
function horizontalSpan(cells: WorkingCell[], ocrWords: OcrWord[]): Span | null {
    let lo = Infinity, hi = -Infinity;
    for (const cell of cells) {
        for (const i of cell.wordIdx) {
            const b = ocrWords[i].box_coords;
            lo = Math.min(lo, b.left);
            hi = Math.max(hi, b.left + b.width);
        }
    }
    return lo <= hi ? { lo, hi } : null;
}

const within = (v: number, s: Span): boolean => v >= s.lo && v <= s.hi;

// Indices of OCR words whose *center* falls inside the row∩column region, in
// reading order, skipping any word another cell already claimed. Centers (not
// overlap) are the test everywhere a cell's region is resolved from anchor
// bands: a word straddling a band edge belongs to whichever side holds its
// middle, so the two passes below can never both take it.
export function unclaimedWordsInRegion(
    ocrWords: OcrWord[],
    claimed: Set<number>,
    rowBand: Span,
    colBand: Span,
): number[] {
    const found: number[] = [];
    for (let i = 0; i < ocrWords.length; i++) {
        if (claimed.has(i)) continue;
        const b = ocrWords[i].box_coords;
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        if (within(cy, rowBand) && within(cx, colBand)) found.push(i);
    }
    return found;
}

// Final recovery pass — grid cross-check (design review F2). Unlike the primary
// grid matcher (which needs detectable whitespace channels), this triangulates a
// still-unmatched cell from words its neighbours *actually matched*: the row
// band comes from already-matched row siblings and the column band from the same
// column in other rows, so it works even when column geometry was too messy to
// detect up front. Only unclaimed words whose center falls inside both bands are
// considered, so it never steals a confidently-placed word; requiring both a row
// and a column anchor keeps it conservative.
function gridMatchPass(
    result: WorkingCell[][],
    ocrWords: OcrWord[],
    claimed: Set<number>,
): void {
    for (let r = 0; r < result.length; r++) {
        for (let c = 0; c < result[r].length; c++) {
            const cell = result[r][c];
            if (cell.matchStatus !== "unmatched") continue;
            const target = normalize(cell.value);
            if (!target) continue;

            const rowBand = verticalSpan(result[r].filter((_, ci) => ci !== c), ocrWords);
            const colBand = horizontalSpan(
                result.map(row => row[c]).filter((rowCell, ri) => ri !== r && rowCell !== undefined),
                ocrWords,
            );
            if (!rowBand || !colBand) continue;

            const candidates = unclaimedWordsInRegion(ocrWords, claimed, rowBand, colBand);

            const best = bestRunMatch(ocrWords, candidates, target);
            if (best) applyRunMatch(cell, best, claimed);
        }
    }
}

// Minimum total normalized characters of unclaimed text inside an empty cell's
// region before the cell is flagged as possibly missing content — a lone stray
// glyph (a rule-line artifact, a speck OCR'd as punctuation) is not evidence.
const MIN_OVERLOOKED_CHARS = 2;

// Emptiness verification (final pass). An empty TSV cell is a claim — "the
// source is blank here" — that no matching pass can check, because there is
// nothing to match. This pass checks it spatially: the cell's row band comes
// from the words its row siblings matched, its column band from the words its
// column matched in other rows — or, for an all-empty column, from the gap
// between the nearest anchored columns on each side. Unclaimed OCR words whose
// centers fall inside both bands are text the model produced nothing for: the
// cell keeps status "empty" but carries those words' ids, so the UI can warn
// about possibly dropped content and highlight exactly what was skipped.
// Claimed words are never counted — content attributed to another cell is not
// "overlooked" — and a region below MIN_OVERLOOKED_CHARS stays unflagged.
// Cells whose region cannot be located from anchors are left unflagged
// (unverifiable, not suspicious).
function verifyEmptyCellsPass(
    result: WorkingCell[][],
    ocrWords: OcrWord[],
    claimed: Set<number>,
): void {
    const columnSpanAt = (c: number, excludeRow: number): Span | null =>
        horizontalSpan(
            result.map(row => row[c]).filter((cell, ri) => ri !== excludeRow && cell !== undefined),
            ocrWords,
        );

    const columnRegion = (r: number, c: number): Span | null => {
        const own = columnSpanAt(c, r);
        if (own) return own;
        // All-empty column: no anchor of its own, so bound its region by the
        // nearest anchored columns on each side. Requiring both sides keeps a
        // first/last empty column unverified rather than sweeping in marginal
        // text from outside the table.
        const width = Math.max(...result.map(row => row.length));
        let lo: number | null = null;
        for (let cc = c - 1; cc >= 0 && lo === null; cc--) {
            const span = columnSpanAt(cc, -1);
            if (span) lo = span.hi;
        }
        let hi: number | null = null;
        for (let cc = c + 1; cc < width && hi === null; cc++) {
            const span = columnSpanAt(cc, -1);
            if (span) hi = span.lo;
        }
        return lo !== null && hi !== null && lo < hi ? { lo, hi } : null;
    };

    for (let r = 0; r < result.length; r++) {
        for (let c = 0; c < result[r].length; c++) {
            const cell = result[r][c];
            if (cell.matchStatus !== "empty") continue;

            const rowBand = verticalSpan(result[r].filter((_, ci) => ci !== c), ocrWords);
            if (!rowBand) continue;
            const colBand = columnRegion(r, c);
            if (!colBand) continue;

            const overlooked = unclaimedWordsInRegion(ocrWords, claimed, rowBand, colBand);
            const chars = overlooked.reduce((n, i) => n + normalize(ocrWords[i].text).length, 0);
            if (chars >= MIN_OVERLOOKED_CHARS) cell.wordIdx = overlooked;
        }
    }
}

export type MatchOptions = {
    /** Defaults to `word` — the tier every shipped preset grounds at. */
    grounding?: GroundingKind;
    /** The bands a `cell`-grounded model reported, in page pixels. */
    grid?: DeclaredGrid | null;
};

/**
 * Decide where the table grid comes from — the one place grounding changes matching.
 *
 * The three tiers ask for genuinely different treatment, and the difference is about
 * what is *known*, not about quality:
 *
 *  - `word` — nothing is known about the grid, so infer it, exactly as before. This
 *    path must stay byte-identical; it is what every shipped preset runs.
 *  - `cell` — the grid was reported. Use it, and fall back to inference if it turns
 *    out not to describe this TSV (see `buildDeclaredTableGrid`). Falling back to
 *    inference rather than straight to the reading-order walk matters: a declined
 *    grid is a mismatch between two descriptions of the page, not evidence that the
 *    page has no columns.
 *  - `block` / `none` — there is nothing to infer a grid *from*. Region boxes have no
 *    whitespace channels between words and no visual lines, so `detectColumnSeparators`
 *    would be reading structure out of noise. The reading-order walk and the fuzzy
 *    pass handle these, and the UI renders their highlights as approximate.
 */
function resolveGrid(
    csvRows: string[][],
    ocrWords: OcrWord[],
    naturalHeight: number | undefined,
    options: MatchOptions | undefined,
): TableGrid | null {
    const grounding = options?.grounding ?? 'word';
    if (grounding === 'block' || grounding === 'none') return null;

    if (grounding === 'cell' && options?.grid) {
        const declared = buildDeclaredTableGrid(csvRows, ocrWords, options.grid);
        if (declared) return declared;
    }
    return detectTableGrid(csvRows, ocrWords, naturalHeight);
}

// Match TSV cells to their source OCR words.
//
// Pipeline: grid-first spatial matching (column bands from whitespace channels,
// TSV rows aligned to visual lines by content) with the reading-order walk as
// the fallback primary, then two recovery passes — fuzzy gap search and the
// band-based grid cross-check — over whatever is still unmatched, and finally
// emptiness verification, which flags empty cells whose source region contains
// text no cell claimed (possible dropped content). All matching passes share
// one claimed-word set, so no pass can steal another's placement.
//
// `naturalHeight` is the source image height used for visual line grouping;
// when omitted it is derived from the words' own extent.
//
// `options.grounding` selects where the grid comes from, and defaults to `word` — the
// tier every shipped preset uses, whose behaviour is unchanged. See `resolveGrid`.
export const matchCellsToOcr = (
    csvRows: string[][],
    ocrWords: OcrWord[],
    naturalHeight?: number,
    options?: MatchOptions,
): CellProvenance[][] => {
    // A blank cell is "empty", never "unmatched" — there is nothing to match,
    // so it must not read as a failed match downstream (badge, low trust).
    const initialStatus = (value: string): WorkingCell['matchStatus'] =>
        normalize(value) ? "unmatched" : "empty";

    const working: WorkingCell[][] = csvRows.map((row, r) =>
        row.map((value, c): WorkingCell => ({
            rowIndex: r, colIndex: c, value, wordIdx: [], matchStatus: initialStatus(value),
        })));
    const claimed = new Set<number>();

    const grid = resolveGrid(csvRows, ocrWords, naturalHeight, options);
    let gridAccepted = false;
    if (grid) {
        gridMatchCells(working, ocrWords, grid, claimed);
        gridAccepted = matchedFraction(working) >= MIN_GRID_MATCH_FRACTION;
        if (!gridAccepted) {
            // The geometry didn't describe this TSV (e.g. the model merged or
            // reordered columns) — discard and let the sequence walk start clean.
            for (const row of working) {
                for (const cell of row) {
                    cell.wordIdx = [];
                    cell.matchStatus = initialStatus(cell.value);
                }
            }
            claimed.clear();
        }
    }
    if (!gridAccepted) sequenceWalkPass(working, ocrWords, claimed);

    // Recovery passes for whatever the primary matcher could not place.
    fuzzyMatchPass(working, ocrWords, claimed);
    gridMatchPass(working, ocrWords, claimed);

    // With every matchable cell placed, whatever text remains unclaimed inside
    // an empty cell's region is possible dropped content — flag it.
    verifyEmptyCellsPass(working, ocrWords, claimed);

    // Convert positional indices to stable UUIDs for storage/resolution.
    return working.map(row =>
        row.map(cell => ({
            rowIndex: cell.rowIndex,
            colIndex: cell.colIndex,
            value: cell.value,
            wordIds: cell.wordIdx.map(i => ocrWords[i].id),
            matchStatus: cell.matchStatus,
        }))
    );
};
