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