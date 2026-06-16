import { describe, it, expect } from 'vitest';
import { toCsv, toHtml, toMarkdown, toPlainText, buildFileStem } from './exportUtils';

describe('toCsv (RFC-4180 escaping)', () => {
    it('joins rows with CRLF and cells with commas', () => {
        expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d');
    });

    it('quotes cells containing a comma', () => {
        expect(toCsv([['a,b', 'c']])).toBe('"a,b",c');
    });

    it('quotes and doubles embedded quotes — even without a comma (M1 regression)', () => {
        expect(toCsv([['he said "hi"']])).toBe('"he said ""hi"""');
    });

    it('quotes cells containing newlines', () => {
        expect(toCsv([['line1\nline2']])).toBe('"line1\nline2"');
    });
});

describe('toPlainText', () => {
    it('joins cells with tabs and rows with newlines', () => {
        expect(toPlainText([['a', 'b'], ['c', 'd']])).toBe('a\tb\nc\td');
    });
});

describe('toHtml', () => {
    it('renders a thead/tbody table and escapes markup', () => {
        const html = toHtml([['H&1', 'H2'], ['<b>', 'd']]);
        expect(html).toContain('<th>H&amp;1</th>');
        expect(html).toContain('<td>&lt;b&gt;</td>');
        expect(html).toContain('<thead>');
        expect(html).toContain('<tbody>');
    });

    it('returns empty string for no rows', () => {
        expect(toHtml([])).toBe('');
    });
});

describe('toMarkdown', () => {
    it('emits a header row, a separator, and padded data rows', () => {
        const md = toMarkdown([['Name', 'Age'], ['Al', '30']]).split('\n');
        expect(md[0]).toContain('Name');
        expect(md[1]).toMatch(/^\| -+ \| -+ \|$/);
        expect(md[2]).toContain('Al');
    });
});

describe('buildFileStem', () => {
    it('sanitizes the source name and appends _extract', () => {
        expect(buildFileStem('My Report.pdf', 0, 1)).toBe('My_Report_extract');
    });

    it('includes the page number for multi-page documents', () => {
        expect(buildFileStem('doc.pdf', 2, 5)).toBe('doc_p3_extract');
    });

    it('falls back to "extraction" when no name is given', () => {
        expect(buildFileStem(null, 0, 1)).toBe('extraction_extract');
    });
});
