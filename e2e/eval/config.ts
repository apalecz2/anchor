import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_PRESET_IDS, DEFAULT_PRESET_ID } from './presets.ts';

// The eval corpus is deliberately NOT an e2e/fixtures/ fixture — that directory's
// own README asks fixtures to stay tiny and never depend on the real model; this
// corpus (236 MB, needs real OCR + LLM inference) is the opposite of that by
// design. It lives in e2e/eval-data/ instead (gitignored — see e2e/.gitignore).

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface EvalConfig {
    /** Image count for this run, or 'all' for the full corpus. */
    sampleSize: number | 'all';
    /** One or more preset ids to run the sample against, in order. */
    presetIds: string[];
    seed: number;
    stratifyByType: boolean;
    corpusDir: string;
    perImageTimeoutMs: number;
    /** Include the full truth/extracted grids in the JSON report — off by default
     *  (a full-corpus run would bloat the report considerably), on for small
     *  diagnostic runs where seeing exactly what mismatched matters more than
     *  report size. */
    saveGrids: boolean;
}

function parseSampleSize(raw: string | undefined): number | 'all' {
    if (!raw || raw === '30') return 30;
    if (raw.toLowerCase() === 'all') return 'all';
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`ANCHOR_EVAL_SAMPLE must be a positive integer or "all", got "${raw}"`);
    }
    return Math.floor(n);
}

function parsePresetIds(raw: string | undefined): string[] {
    const value = raw ?? DEFAULT_PRESET_ID;
    if (value.toLowerCase() === 'all') return ALL_PRESET_IDS;
    const ids = value.split(',').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
        if (!ALL_PRESET_IDS.includes(id)) {
            throw new Error(
                `ANCHOR_EVAL_PRESET names unknown preset "${id}". Known presets: ${ALL_PRESET_IDS.join(', ')}, or "all".`,
            );
        }
    }
    return ids;
}

export function loadEvalConfig(env: NodeJS.ProcessEnv = process.env): EvalConfig {
    return {
        sampleSize: parseSampleSize(env.ANCHOR_EVAL_SAMPLE),
        presetIds: parsePresetIds(env.ANCHOR_EVAL_PRESET),
        seed: env.ANCHOR_EVAL_SEED ? Number(env.ANCHOR_EVAL_SEED) : 42,
        stratifyByType: (env.ANCHOR_EVAL_STRATIFY ?? 'type').toLowerCase() !== 'off',
        corpusDir: env.ANCHOR_EVAL_CORPUS_DIR ?? path.resolve(__dirname, '..', 'eval-data'),
        perImageTimeoutMs: env.ANCHOR_EVAL_TIMEOUT_MS ? Number(env.ANCHOR_EVAL_TIMEOUT_MS) : 180_000,
        saveGrids: (env.ANCHOR_EVAL_SAVE_GRIDS ?? '').toLowerCase() === '1'
            || (env.ANCHOR_EVAL_SAVE_GRIDS ?? '').toLowerCase() === 'true',
    };
}
