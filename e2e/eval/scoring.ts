import { normalizeCell } from './htmlTableToGrid.ts';

export interface ScoreResult {
    cellAccuracy: number;
    matchedCells: number;
    scoredCells: number;
    rowCountMatch: boolean;
    colCountMatch: boolean;
    /** Actual dimensions, not just the match booleans — a mismatch here (e.g. one
     *  extra/missing row) cascades into a near-total cellAccuracy collapse under
     *  this scorer's unaligned positional comparison, so knowing *how far off* the
     *  dimensions are is what distinguishes that from genuinely wrong cell content. */
    truthRows: number;
    truthCols: number;
    extractedRows: number;
    extractedCols: number;
}

/**
 * Positional grid cell-accuracy — not TEDS (tree-edit-distance similarity, the
 * metric PubTabNet-style benchmarks normally report). Both grids are padded to the
 * larger of the two dimensions and compared index-for-index; an empty-vs-empty
 * padded cell counts as a match. Simpler to implement and fast enough to run over
 * thousands of images, at the cost of not tolerating a single inserted/deleted row
 * or column shifting every cell after it out of alignment — accepted for this pass
 * (docs/TEST_PLAN.md's eval-suite section).
 */
export function scoreGrids(truth: string[][], extracted: string[][]): ScoreResult {
    const rows = Math.max(truth.length, extracted.length);
    const cols = Math.max(0, ...truth.map(r => r.length), ...extracted.map(r => r.length));

    let matched = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const t = normalizeCell(truth[r]?.[c] ?? '');
            const e = normalizeCell(extracted[r]?.[c] ?? '');
            if (t === e) matched++;
        }
    }

    const total = rows * cols;
    return {
        cellAccuracy: total === 0 ? 1 : matched / total,
        matchedCells: matched,
        scoredCells: total,
        rowCountMatch: truth.length === extracted.length,
        colCountMatch: (truth[0]?.length ?? 0) === (extracted[0]?.length ?? 0),
        truthRows: truth.length,
        truthCols: truth[0]?.length ?? 0,
        extractedRows: extracted.length,
        extractedCols: extracted[0]?.length ?? 0,
    };
}
