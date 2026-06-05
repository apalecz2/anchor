// Generous per-cell token budget (§4.4): value tokens + "|wordId" + delimiter ≈ 8.
const TOKENS_PER_CELL = 8;

// Compute max_tokens for a table extraction request (§4.4).
// estimatedCols should include the header row in estimatedRows.
export const computeMaxTokens = (estimatedRows: number, estimatedCols: number): number =>
    Math.max(64, estimatedRows * estimatedCols * TOKENS_PER_CELL);

// System prompt for pipe-format table extraction (§5.3). Keep short — it's prefill cost.
export const TABLE_EXTRACTION_SYSTEM_PROMPT =
    'Extract the table as rows. One line per row, tab-separated cells.\n' +
    'Each cell: VALUE|WORDID\n' +
    'VALUE = the correct text (use the image; fix OCR errors). Write a literal pipe inside a value as \\|.\n' +
    'WORDID = the id of the OCR word it came from, or -1 if not in the OCR list.\n' +
    'Include the header row as the first row. Output only rows. No commentary.';

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

const parseFields = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else { inQuotes = !inQuotes; }
        } else if (ch === ',' && !inQuotes) {
            fields.push(current.trim()); current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current.trim());
    return fields;
};

export const parseCSV = (raw: string): string[][] => {
    const text = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    if (!text) return [];

    const rows: string[][] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        rows.push(parseFields(line));
    }
    return rows;
};

/**
 * Builds a GBNF grammar string for pipe-format table extraction (§4.1 / §4.2).
 * When columnCount is provided the row rule fixes the column count exactly (§4.1),
 * which prevents the model from emitting ragged rows. Without it the variable-column
 * variant (§4.2) is used.
 */
export const buildGbnfGrammar = (columnCount?: number): string => {
    // §4.1: fixed columns — repeat "tab cell" (N-1) times after the first cell
    // §4.2: variable columns — allow one or more cells separated by tabs
    const rowRule =
        columnCount !== undefined && columnCount >= 1
            ? `cell${' tab cell'.repeat(columnCount - 1)}`
            : 'cell (tab cell)*';

    // Note on escaping: this string is sent verbatim to llama.cpp as GBNF.
    // JS template-literal `\\t` → JS string `\t` → GBNF escape for tab, etc.
    return [
        `root        ::= row (nl row)* nl?`,
        `row         ::= ${rowRule}`,
        `cell        ::= value "|" wordid`,
        `value       ::= vchar+`,
        `vchar       ::= [^\\t\\n\\\\|] | "\\\\|" | "\\\\\\\\"`,
        `wordid      ::= "-1" | [0-9]+`,
        `tab         ::= "\\t"`,
        `nl          ::= "\\n"`,
    ].join('\n');
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