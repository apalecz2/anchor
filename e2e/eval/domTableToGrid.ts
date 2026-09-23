import type { ChainablePromiseElement } from 'webdriverio';

/**
 * Scrapes the app's own live, rendered table into a dense grid, keyed off each
 * data cell's `data-cell-row`/`data-cell-col` attributes (`ProvenanceTable.tsx`'s
 * `cellHandlers`) rather than raw DOM row/column position.
 *
 * This matters: the rendered `<table>` also carries spreadsheet-editor chrome —
 * a leading column-letter header row (`columnLabel`, "A", "B", …) and a leading
 * row-number gutter column, both plain `<th>` cells with **no**
 * `data-cell-*` attributes. Walking `<tr>`/`<td,th>` in raw DOM order (as an
 * earlier version of this function did) picks up that chrome as if it were data,
 * shifting every real cell by one row and one column — which cascades into a
 * near-total accuracy collapse under scoring.ts's unaligned positional
 * comparison, even when the actual extraction was largely correct. Confirmed by
 * running a diagnostic pass with ANCHOR_EVAL_SAVE_GRIDS=1 and comparing the
 * scraped grid against the source image by hand.
 *
 * Each real cell's value also isn't the element's full text: `ProvenanceTable`
 * renders `cell.value` in a `<span>`, followed by sibling `<span>` confidence/
 * verification badges (✓ / ! / ? — `CellBadges`) inside the same flex wrapper.
 * `.getText()` on the whole cell folds the badge glyph into the value. The
 * value's `<span>` is always first in DOM order (it's written before
 * `<CellBadges/>` in JSX), so reading only that first `<span>` isolates the
 * actual value.
 */
export async function scrapeTableGrid(
    table: WebdriverIO.Element | ChainablePromiseElement,
): Promise<string[][]> {
    const cells = await table.$$('[data-cell-row]');
    const entries: { row: number; col: number; text: string }[] = [];

    for (const cellEl of cells) {
        const row = Number(await cellEl.getAttribute('data-cell-row'));
        const col = Number(await cellEl.getAttribute('data-cell-col'));
        if (!Number.isFinite(row) || !Number.isFinite(col)) continue;

        const valueSpan = cellEl.$('span');
        const text = (await valueSpan.isExisting()) ? await valueSpan.getText() : await cellEl.getText();
        entries.push({ row, col, text });
    }

    const maxRow = entries.reduce((m, e) => Math.max(m, e.row), -1);
    const maxCol = entries.reduce((m, e) => Math.max(m, e.col), -1);
    const grid: string[][] = Array.from({ length: maxRow + 1 }, () => Array(maxCol + 1).fill(''));
    for (const { row, col, text } of entries) grid[row][col] = text;
    return grid;
}
