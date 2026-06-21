// Copy tabular data to the clipboard the way a spreadsheet (or Claude's chat) does:
// TSV as text/plain (pastes into a text editor) plus an HTML <table> (pastes as a real
// grid into Excel / Google Sheets / docs). Cells containing tabs, newlines, or quotes
// are quoted like Excel's TSV so the row/column structure survives a plain-text paste.
export async function copyTableToClipboard(rows: string[][]): Promise<void> {
    if (rows.length === 0) return;

    const tsvCell = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const tsv = rows.map(r => r.map(tsvCell).join('\t')).join('\n');

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const [head, ...body] = rows;
    const html =
        '<table>' +
        (head ? `<thead><tr>${head.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : '') +
        `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
        '</table>';

    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
        })]);
    } else {
        // Older webviews without ClipboardItem: TSV-only still pastes cleanly into a grid.
        await navigator.clipboard.writeText(tsv);
    }
}
