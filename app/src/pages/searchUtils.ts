// Pure helpers for the Search page, split out so they can be unit-tested without
// pulling the whole page (react-router, db) into a node test.

// SQLite's CURRENT_TIMESTAMP is UTC with no timezone marker ('YYYY-MM-DD HH:MM:SS').
// `new Date()` would parse that as *local* time, skewing "Last updated" by the UTC
// offset. Tag it as UTC (ISO 'T...Z') so it's interpreted correctly. A value that
// doesn't match the SQLite shape is passed through unchanged (and, if unparseable,
// returned verbatim rather than as "Invalid Date").
export function formatSqliteTimestamp(ts: string): string {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)
        ? `${ts.replace(' ', 'T')}Z`
        : ts;
    const date = new Date(normalized);
    return isNaN(date.getTime()) ? ts : date.toLocaleDateString();
}

// Escape LIKE metacharacters so a query such as "100%" or "a_b" matches literally
// instead of acting as wildcards. Paired with `ESCAPE '\'` in the query.
export function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
