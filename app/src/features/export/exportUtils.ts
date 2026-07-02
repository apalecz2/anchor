/** Pure serializers: string[][] → various formats. Row 0 is the header row. */

function escCsv(cell: string): string {
    const escaped = cell.replace(/"/g, '""');
    return /[,"\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

export function toCsv(rows: string[][]): string {
    return rows.map(row => row.map(escCsv).join(',')).join('\r\n');
}

function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function toHtml(rows: string[][]): string {
    if (rows.length === 0) return '';
    const [header, ...data] = rows;
    const thead =
        `  <thead>\n    <tr>${header.map(h => `<th>${escHtml(h)}</th>`).join('')}</tr>\n  </thead>`;
    const tbody =
        `  <tbody>\n${data.map(row =>
            `    <tr>${row.map(c => `<td>${escHtml(c)}</td>`).join('')}</tr>`
        ).join('\n')}\n  </tbody>`;
    return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head><meta charset="UTF-8"><title>Exported Table</title></head>',
        '<body>',
        '<table border="1" cellpadding="4" cellspacing="0">',
        thead,
        tbody,
        '</table>',
        '</body>',
        '</html>',
    ].join('\n');
}

export function toMarkdown(rows: string[][]): string {
    if (rows.length === 0) return '';
    const [header, ...data] = rows;

    const colCount = Math.max(header.length, ...data.map(r => r.length));
    const widths = Array.from({ length: colCount }, (_, i) =>
        Math.max(
            3,
            (header[i] ?? '').length,
            ...data.map(row => (row[i] ?? '').length)
        )
    );

    const pad = (s: string, w: number) => s.padEnd(w);
    const row2md = (row: string[]) =>
        `| ${Array.from({ length: colCount }, (_, i) => pad(row[i] ?? '', widths[i])).join(' | ')} |`;

    const sep = `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`;

    return [row2md(header), sep, ...data.map(row2md)].join('\n');
}

export function toPlainText(rows: string[][]): string {
    return rows.map(row => row.join('\t')).join('\n');
}

/** Sanitize a source document name for use as a filename stem (no extension). */
export function buildFileStem(sourceName: string | null, pageIndex: number, totalPages: number): string {
    const base = sourceName
        ? sourceName
            .replace(/\.[^.]+$/, '')            // strip extension
            .replace(/[^a-zA-Z0-9_-]/g, '_')   // replace illegal chars
            .replace(/_+/g, '_')                // collapse repeated underscores
            .replace(/^_|_$/g, '')              // trim leading/trailing underscores
            .slice(0, 50)
        : 'extraction';
    const safe = base || 'extraction';
    return totalPages > 1 ? `${safe}_p${pageIndex + 1}_extract` : `${safe}_extract`;
}

export interface SaveFormat {
    ext: string;
    label: string;
    filters: { name: string; extensions: string[] }[];
}

/** Open the OS native Save As dialog; returns the chosen path, or null if the user cancelled. */
async function pickSavePath(stem: string, format: SaveFormat): Promise<string | null> {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({
        defaultPath: `${stem}.${format.ext}`,
        filters: format.filters,
    });
}

/** Open the OS native Save As dialog and write text content to the chosen path. Returns false if user cancelled. */
export async function saveWithDialog(
    stem: string,
    content: string,
    format: SaveFormat
): Promise<boolean> {
    const path = await pickSavePath(stem, format);
    if (!path) return false;

    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(path, content);
    return true;
}

/**
 * Open the OS native Save As dialog and write an XLSX workbook to the chosen path.
 * The workbook itself is built on the Rust side (`export_xlsx`) via `rust_xlsxwriter`,
 * since XLSX is a binary zip/XML format best left to a dedicated writer rather than
 * hand-rolled in the frontend. Returns false if the user cancelled.
 */
export async function saveXlsxWithDialog(
    stem: string,
    rows: string[][],
    format: SaveFormat
): Promise<boolean> {
    const path = await pickSavePath(stem, format);
    if (!path) return false;

    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('export_xlsx', { rows, destPath: path });
    return true;
}
