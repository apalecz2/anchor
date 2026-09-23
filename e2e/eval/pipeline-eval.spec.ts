import { $ } from '@wdio/globals';
import path from 'node:path';
import { loadEvalConfig } from './config.ts';
import { loadCorpus, pickSample } from './sampling.ts';
import { htmlTableToGrid } from './htmlTableToGrid.ts';
import { scrapeTableGrid } from './domTableToGrid.ts';
import { scoreGrids } from './scoring.ts';
import { selectPreset, resetToDashboard } from './presetUi.ts';
import { writeReport, type ImageResult } from './reportWriter.ts';
import type { CorpusEntry } from './sampling.ts';

// Pipeline-accuracy eval (docs/TESTING.md, docs/TEST_PLAN.md) — NOT part of the PR
// gate or any CI workflow. Drives the real app exactly as a user would (file input →
// OCR viewer → Format as Table → rendered table) against the eval-data/ corpus, and
// scores the result against ground truth. Deliberately violates TEST_PLAN.md §1's
// "no test depends on a real model" determinism principle: that's the point of this
// suite. Requires a real setup wizard run already completed on this machine (actual
// Tesseract/llama-server/pdfium/model files installed) — see docs/TESTING.md.
//
// Run with: npm run e2e:eval  (see e2e/eval/config.ts for ANCHOR_EVAL_* env vars)

async function runOneImage(
    imagePath: string,
    entry: CorpusEntry,
    timeoutMs: number,
    saveGrids: boolean,
): Promise<ImageResult> {
    const base = { filename: entry.filename, type: entry.type } as const;
    try {
        await (await $('input[type="file"]')).setValue(imagePath);

        const viewer = await $('svg, canvas, [data-testid="document-viewer"]');
        try {
            await viewer.waitForExist({ timeout: 60_000 });
        } catch {
            return { ...base, status: 'viewer-timeout' };
        }

        // Note: WDIO's `tag*=text` strategy has no comma-OR support — the whole
        // string after `*=` is one literal search text (see
        // XPATH_SELECTOR_REGEXP's `/(\*)?=(.+)$/`, which captures greedily to
        // end of string). A `'button*=Format as Table, button*=Format'`-style
        // selector silently searches for that literal comma-joined text and
        // never matches anything real — caught by running this against the
        // actual app. "Format as Table" is the button's exact rendered text
        // (ExtractionOutputPane.tsx).
        await (await $('button*=Format as Table')).click();

        const table = await $('table');
        const pageError = await $('*=could not be processed');
        const outcome = await Promise.race([
            table.waitForExist({ timeout: timeoutMs }).then(() => 'table' as const),
            pageError.waitForExist({ timeout: timeoutMs }).then(() => 'error' as const),
        ]).catch(() => 'timeout' as const);

        if (outcome === 'error') return { ...base, status: 'page-error' };
        if (outcome === 'timeout') return { ...base, status: 'table-timeout' };

        const extractedGrid = await scrapeTableGrid(table);
        const truthGrid = htmlTableToGrid(entry.html);
        return {
            ...base,
            status: 'scored',
            score: scoreGrids(truthGrid, extractedGrid),
            ...(saveGrids ? { truthGrid, extractedGrid } : {}),
        };
    } catch (err) {
        return { ...base, status: 'exception', error: String(err) };
    } finally {
        // Best-effort: one broken image must not wedge the rest of the run.
        await resetToDashboard().catch(() => {});
    }
}

describe('Pipeline extraction accuracy (manual eval, not CI)', () => {
    const cfg = loadEvalConfig();
    const corpus = loadCorpus(path.join(cfg.corpusDir, 'final_eval.json'));
    const sample = pickSample(corpus, {
        size: cfg.sampleSize,
        seed: cfg.seed,
        stratifyByType: cfg.stratifyByType,
    });

    for (const presetId of cfg.presetIds) {
        it(`scores preset "${presetId}" against ${sample.length} images`, async function () {
            // No explicit this.timeout() override here: mochaOpts.timeout in
            // wdio.eval.conf.ts already sets a generous, finite ceiling for every
            // test under this config. A literal `0` (meant as "no timeout") looks
            // right in plain Mocha but breaks WDIO's own per-command timeout
            // wrapper, which computes `remaining = timeout - elapsed` — with
            // timeout 0 that goes negative and the test fails almost instantly
            // ("Timeout after -3ms"). Always use a large finite number instead.
            const startedAt = new Date().toISOString();

            await selectPreset(presetId);

            const results: ImageResult[] = [];
            for (const entry of sample) {
                const imagePath = path.join(cfg.corpusDir, 'final_eval', entry.filename);
                results.push(await runOneImage(imagePath, entry, cfg.perImageTimeoutMs, cfg.saveGrids));
            }

            const outPath = writeReport({ presetId, seed: cfg.seed, startedAt, results });
            const scored = results.filter(r => r.status === 'scored' && r.score);
            const meanAccuracy = scored.length
                ? scored.reduce((sum, r) => sum + (r.score?.cellAccuracy ?? 0), 0) / scored.length
                : null;
            // eslint-disable-next-line no-console -- this run's headline number belongs on the console, not just in the JSON file
            console.log(
                `[eval] ${presetId}: ${scored.length}/${results.length} scored, ` +
                    `mean cell accuracy ${meanAccuracy === null ? 'n/a' : meanAccuracy.toFixed(3)} ` +
                    `→ ${outPath}`,
            );
        });
    }
});
