import { parse } from 'node-html-parser';

type Carry = { text: string; remaining: number };

/** Places `col`'s carried value (if any) into the row and advances past it,
 *  returning the next free column. Called both between real cells and after the
 *  last one, so a carry parked past a row's final `<td>` still gets consumed. */
function drainCarry(carry: Map<number, Carry>, row: string[], col: number): number {
    while (carry.has(col)) {
        const c = carry.get(col)!;
        row[col] = c.text;
        c.remaining -= 1;
        if (c.remaining <= 0) carry.delete(col);
        col++;
    }
    return col;
}

/**
 * Expands ground-truth HTML (PubTabNet-style: `<td rowspan>`/`<td colspan>`, cells
 * used even inside `<thead>`) into a dense, positionally-indexed grid, so it can be
 * compared cell-by-cell against the app's own rendered `<table>` (see scoring.ts).
 *
 * Standard occupancy-grid expansion: walk each row left to right, tracking which
 * columns are still "owed" a cell by an earlier row's rowspan (`carry`, keyed by
 * column, shared across rows). Before placing each real `<td>`/`<th>` — and again
 * after the row's last one — drain any carries sitting at the current column, so a
 * rowspan that outlives this row's own cells (nothing new to say in a carried
 * column) is still filled in rather than left for a `col++` loop with no cell left
 * to anchor it, which would spin forever chasing a carry it can never reach.
 */
export function htmlTableToGrid(html: string): string[][] {
    const rows = parse(html).querySelectorAll('tr');
    const grid: string[][] = [];
    const carry = new Map<number, Carry>();
    let maxCols = 0;

    rows.forEach((tr, rowIdx) => {
        const row: string[] = [];
        let col = 0;

        for (const cell of tr.querySelectorAll('td, th')) {
            col = drainCarry(carry, row, col);

            const text = normalizeCell(cell.text);
            const colspan = parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1;
            const rowspan = parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1;
            for (let i = 0; i < colspan; i++) {
                row[col] = text;
                if (rowspan > 1) carry.set(col, { text, remaining: rowspan - 1 });
                col++;
            }
        }
        col = drainCarry(carry, row, col);

        grid[rowIdx] = row;
        maxCols = Math.max(maxCols, col);
    });

    for (const row of grid) {
        while (row.length < maxCols) row.push('');
    }
    return grid;
}

/** Trim, collapse internal whitespace, lowercase, and fold the Unicode minus
 *  sign (U+2212, common in ground-truth scientific tables, e.g. "−0.23") to an
 *  ASCII hyphen — cheap, order-independent normalization so OCR/LLM casing,
 *  spacing, and this specific typographic quirk don't count as mismatches when
 *  the numeric value itself is right. Confirmed as a real, recurring false
 *  mismatch via a diagnostic run with ANCHOR_EVAL_SAVE_GRIDS=1. */
export function normalizeCell(s: string): string {
    return s.trim().replace(/\s+/g, ' ').replace(/−/g, '-').toLowerCase();
}
