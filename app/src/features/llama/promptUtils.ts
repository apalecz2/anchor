// readFileAsBase64, compactOcrText, and buildOcrExcerpt support the conversational
// chat path and have no caller yet — intentionally retained for the planned chat
// feature (design §8), not dead code. parseCSV below is live.
export const readFileAsBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = event => {
            const dataUrl = event.target?.result as string;
            resolve(dataUrl.split(',')[1] ?? '');
        };

        reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
        reader.readAsDataURL(file);
    });

export const compactOcrText = (text: string) =>
    text
        .split(/\r?\n/)
        .map(line => line.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join('\n');

// Full RFC-4180 CSV parser: walks the whole string in one pass so a quoted field
// may legally contain commas, quotes ("" escape), and newlines. A line-by-line
// split (the old approach) would shred a quoted multi-line cell across rows — safe
// only as long as values never contain newlines, an invariant we don't want to
// depend on. Pairs with `toCsv` (exportUtils), which is RFC-4180 on the way out,
// so any value round-trips through extract → store → render/copy without corruption.
export const parseCSV = (raw: string): string[][] => {
    const text = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '');

    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let sawField = false; // distinguishes a real (possibly empty) field from "no field yet"

    const endField = () => { row.push(field.trim()); field = ''; sawField = false; };
    const endRow = () => {
        endField();
        // Skip blank lines (a row that is a single empty field), matching prior behavior.
        if (!(row.length === 1 && row[0] === '')) rows.push(row);
        row = [];
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
                else { inQuotes = false; }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') { inQuotes = true; sawField = true; }
        else if (ch === ',') { endField(); }
        else if (ch === '\n') { endRow(); }
        else if (ch === '\r') { /* swallow; \n (or end) closes the row */ }
        else { field += ch; sawField = true; }
    }
    // Flush a trailing field/row that wasn't terminated by a newline.
    if (sawField || field !== '' || row.length > 0) endRow();

    return rows;
};

export const buildOcrExcerpt = (text: string, maxLines: number, maxCharacters: number) => {
    const lines = compactOcrText(text).split('\n').filter(Boolean);
    const excerptLines: string[] = [];
    let characterCount = 0;

    for (const line of lines) {
        if (excerptLines.length >= maxLines || characterCount >= maxCharacters) {
            break;
        }

        const clippedLine = line.slice(0, Math.max(0, maxCharacters - characterCount));

        if (!clippedLine) {
            break;
        }

        excerptLines.push(clippedLine);
        characterCount += clippedLine.length + 1;
    }

    const hasMoreContent = excerptLines.length < lines.length;

    if (hasMoreContent) {
        excerptLines.push('[truncated OCR excerpt]');
    }

    return excerptLines.join('\n');
};