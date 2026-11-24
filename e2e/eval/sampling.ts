import { readFileSync } from 'node:fs';

export interface CorpusEntry {
    filename: string;
    html: string;
    type: string;
}

export function loadCorpus(jsonPath: string): CorpusEntry[] {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<
        string,
        { html: string; type: string }
    >;
    return Object.entries(raw).map(([filename, v]) => ({ filename, ...v }));
}

/** Tiny deterministic PRNG (mulberry32) — no dependency needed for reproducible sampling. */
function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seededShuffle<T>(items: T[], rand: () => number): T[] {
    const shuffled = items.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/** Manual grouping (not `Map.groupBy`, which needs Node 21+) so this stays portable
 *  to whatever Node version happens to run the eval suite. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
    }
    return groups;
}

export interface SampleOptions {
    /** Image count, or 'all' for the full corpus (unshuffled, in filename order). */
    size: number | 'all';
    seed: number;
    /** Preserve the corpus's `type` mix in the sample rather than pure random pick. */
    stratifyByType: boolean;
}

/**
 * Deterministic, seeded sample of the corpus. Sorting by filename before shuffling
 * matters: object/JSON key iteration order isn't guaranteed stable across platforms
 * or Node versions, and the seed must reproduce the same sample regardless of how
 * `final_eval.json` happened to be parsed this run.
 */
export function pickSample(all: CorpusEntry[], opts: SampleOptions): CorpusEntry[] {
    const sorted = all.slice().sort((a, b) => a.filename.localeCompare(b.filename));
    if (opts.size === 'all') return sorted;
    // Narrowed to a local: TS narrowing of a captured object property does not
    // survive into the forEach closure below, so `opts.size` there would still be
    // typed `number | 'all'`.
    const sampleSize: number = opts.size;

    const groups = opts.stratifyByType ? groupBy(sorted, e => e.type) : new Map([['_all', sorted]]);
    const rand = mulberry32(opts.seed);
    const groupEntries = [...groups.entries()];

    const picked: CorpusEntry[] = [];
    let remaining = sampleSize;
    groupEntries.forEach(([, entries], i) => {
        // Proportional allocation by group size; the last group absorbs whatever
        // rounding remainder is left so the total always equals opts.size exactly
        // (as long as the corpus has at least that many entries overall).
        const isLast = i === groupEntries.length - 1;
        const target = isLast ? remaining : Math.round((entries.length / sorted.length) * sampleSize);
        const take = Math.min(Math.max(target, 0), entries.length, remaining);
        picked.push(...seededShuffle(entries, rand).slice(0, take));
        remaining -= take;
    });

    return picked.sort((a, b) => a.filename.localeCompare(b.filename));
}
