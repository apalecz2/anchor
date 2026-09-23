import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScoreResult } from './scoring.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, '..', 'eval-results');

export type ImageStatus =
    | 'scored'
    | 'viewer-timeout'
    | 'table-timeout'
    | 'page-error'
    | 'exception';

export interface ImageResult {
    filename: string;
    type: string;
    status: ImageStatus;
    score?: ScoreResult;
    error?: string;
    /** Only populated when ANCHOR_EVAL_SAVE_GRIDS is set — the full grids behind
     *  a `scored` result's numbers, for inspecting exactly what mismatched. */
    truthGrid?: string[][];
    extractedGrid?: string[][];
}

export interface RunReport {
    presetId: string;
    seed: number;
    sampleSize: number;
    startedAt: string;
    finishedAt: string;
    summary: {
        scored: number;
        byStatus: Record<ImageStatus, number>;
        meanCellAccuracy: number | null;
        rowCountMatchRate: number | null;
        colCountMatchRate: number | null;
    };
    results: ImageResult[];
}

function summarize(results: ImageResult[]): RunReport['summary'] {
    const byStatus = {
        scored: 0,
        'viewer-timeout': 0,
        'table-timeout': 0,
        'page-error': 0,
        exception: 0,
    } satisfies Record<ImageStatus, number>;
    for (const r of results) byStatus[r.status]++;

    const scoredResults = results.filter(
        (r): r is ImageResult & { score: ScoreResult } => r.status === 'scored' && r.score !== undefined,
    );
    const mean = (values: number[]): number | null =>
        values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

    return {
        scored: scoredResults.length,
        byStatus,
        meanCellAccuracy: mean(scoredResults.map(r => r.score.cellAccuracy)),
        rowCountMatchRate: mean(scoredResults.map(r => (r.score.rowCountMatch ? 1 : 0))),
        colCountMatchRate: mean(scoredResults.map(r => (r.score.colCountMatch ? 1 : 0))),
    };
}

export interface WriteReportInput {
    presetId: string;
    seed: number;
    startedAt: string;
    results: ImageResult[];
}

/** Aggregates and writes one preset's run to a timestamped JSON file under
 *  e2e/eval-results/ (gitignored) so runs across presets/time can be compared by
 *  hand or with a follow-up script. */
export function writeReport(input: WriteReportInput): string {
    mkdirSync(RESULTS_DIR, { recursive: true });

    const report: RunReport = {
        presetId: input.presetId,
        seed: input.seed,
        sampleSize: input.results.length,
        startedAt: input.startedAt,
        finishedAt: new Date().toISOString(),
        summary: summarize(input.results),
        results: input.results,
    };

    const safeId = input.presetId.replace(/[^a-z0-9.-]/gi, '_');
    const stamp = report.finishedAt.replace(/[:.]/g, '-');
    const outPath = path.join(RESULTS_DIR, `${safeId}-${stamp}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
    return outPath;
}
