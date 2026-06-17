// readFileAsBase64, compactOcrText, and buildOcrExcerpt support the conversational
// chat path and have no caller yet — intentionally retained for the planned chat
// feature (design §8), not dead code. parseCSV/parseFields below are live.
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