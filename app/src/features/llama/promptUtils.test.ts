import { describe, it, expect } from 'vitest';
import { parseCSV, compactOcrText, buildOcrExcerpt } from './promptUtils';

describe('parseCSV (RFC-4180)', () => {
    it('splits a simple grid into rows and trimmed fields', () => {
        expect(parseCSV('a,b,c\n1,2,3')).toEqual([
            ['a', 'b', 'c'],
            ['1', '2', '3'],
        ]);
    });

    it('keeps commas inside a quoted field', () => {
        expect(parseCSV('"Smith, John",30')).toEqual([['Smith, John', '30']]);
    });

    it('unescapes a doubled quote inside a quoted field', () => {
        expect(parseCSV('"She said ""hi""",x')).toEqual([['She said "hi"', 'x']]);
    });

    it('keeps a newline inside a quoted field rather than starting a new row', () => {
        const rows = parseCSV('"line1\nline2",b');
        expect(rows).toEqual([['line1\nline2', 'b']]);
    });

    it('strips a leading ```csv fence and a trailing fence', () => {
        expect(parseCSV('```csv\na,b\n1,2\n```')).toEqual([
            ['a', 'b'],
            ['1', '2'],
        ]);
    });

    it('skips blank lines between data rows', () => {
        expect(parseCSV('a,b\n\n1,2\n\n')).toEqual([
            ['a', 'b'],
            ['1', '2'],
        ]);
    });

    it('trims surrounding whitespace on unquoted fields', () => {
        expect(parseCSV('  a , b ')).toEqual([['a', 'b']]);
    });

    it('treats a trailing comma as a real empty final field', () => {
        expect(parseCSV('a,')).toEqual([['a', '']]);
    });

    it('flushes a final row not terminated by a newline', () => {
        expect(parseCSV('only')).toEqual([['only']]);
    });

    it('returns [] for empty input', () => {
        expect(parseCSV('')).toEqual([]);
    });
});

describe('compactOcrText', () => {
    it('collapses internal whitespace and drops empty lines', () => {
        expect(compactOcrText('  a   b  \n\n   \n c\td  ')).toBe('a b\nc d');
    });

    it('handles CRLF line endings', () => {
        expect(compactOcrText('a\r\n\r\nb')).toBe('a\nb');
    });

    it('returns empty string for whitespace-only input', () => {
        expect(compactOcrText('   \n\t\n  ')).toBe('');
    });
});

describe('buildOcrExcerpt', () => {
    it('returns all lines unchanged when under both limits', () => {
        expect(buildOcrExcerpt('a\nb\nc', 10, 100)).toBe('a\nb\nc');
    });

    it('truncates at maxLines and appends the truncation marker', () => {
        const out = buildOcrExcerpt('a\nb\nc\nd', 2, 100);
        expect(out).toBe('a\nb\n[truncated OCR excerpt]');
    });

    it('truncates at maxCharacters', () => {
        // each line "aaaa" is 4 chars + 1 for the implicit newline = 5 toward the budget
        const out = buildOcrExcerpt('aaaa\nbbbb\ncccc', 10, 6);
        expect(out).toContain('aaaa');
        expect(out).toContain('[truncated OCR excerpt]');
        expect(out).not.toContain('cccc');
    });

    it('does not append the marker when nothing was dropped', () => {
        expect(buildOcrExcerpt('a\nb', 5, 100)).not.toContain('[truncated');
    });
});
