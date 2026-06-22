import { describe, it, expect } from 'vitest';
import { formatSqliteTimestamp, escapeLike } from './searchUtils';

describe('formatSqliteTimestamp (L4)', () => {
    it('interprets a SQLite UTC timestamp as UTC, not local', () => {
        // 2026-06-21 00:30:00 UTC -> a valid, locale-formatted date string.
        const out = formatSqliteTimestamp('2026-06-21 00:30:00');
        // toLocaleDateString output varies by host locale; assert it parsed to a real date.
        expect(out).not.toBe('Invalid Date');
        const expected = new Date('2026-06-21T00:30:00Z').toLocaleDateString();
        expect(out).toBe(expected);
    });

    it('passes an unparseable value through verbatim', () => {
        expect(formatSqliteTimestamp('not a date')).toBe('not a date');
    });

    it('passes a non-SQLite-shaped string through to Date parsing', () => {
        // Already ISO with Z — should still format to a valid date.
        expect(formatSqliteTimestamp('2026-01-01T12:00:00Z')).toBe(
            new Date('2026-01-01T12:00:00Z').toLocaleDateString(),
        );
    });
});

describe('escapeLike (L5)', () => {
    it('escapes percent, underscore, and backslash', () => {
        expect(escapeLike('100%')).toBe('100\\%');
        expect(escapeLike('a_b')).toBe('a\\_b');
        expect(escapeLike('c\\d')).toBe('c\\\\d');
    });

    it('leaves ordinary text untouched', () => {
        expect(escapeLike('hello world')).toBe('hello world');
    });

    it('escapes a SQL-injection-flavoured string literally', () => {
        // The metacharacters are escaped; quotes/semicolons are bind-param-safe and
        // pass through unchanged (they cannot break a parameterized query).
        expect(escapeLike("%_';--")).toBe("\\%\\_';--");
    });
});
