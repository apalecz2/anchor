import { $, browser } from '@wdio/globals';
import { PRESET_LABELS } from './presets.ts';

async function openFileMenuItem(matchText: string): Promise<void> {
    await (await $('button=File')).click();
    await (await $(`button*=${matchText}`)).click();
}

/**
 * Selects a pipeline preset via Settings ▸ Pipeline, exactly as a user would —
 * the executor always reads whichever preset was last persisted there (see
 * `run_extraction_pipeline` in `pipeline/executor.rs`), there is no per-call
 * override from the frontend.
 *
 * Matches the preset's label on the *first text node* of its `<p>`, not a plain
 * substring: labels are not mutually exclusive as substrings ("Accurate" is a
 * substring of "Accurate (Rust OCR)"), so `contains()` would risk selecting the
 * wrong radio.
 *
 * `PipelineSection.tsx` only renders a radio list when the build ships 2+
 * presets — `catalog.rs`'s `PRESETS` is `cfg(debug_assertions)`-gated, so a
 * **release** build ships only `tesseract-qwen3.5-4b` and Settings shows plain
 * informational text ("Anchor runs the X pipeline...") instead, with nothing to
 * click. Handle that case rather than hanging waiting for a radio that will
 * never exist: if the single preset already named is the one requested, there's
 * nothing to do; otherwise fail with an actionable message instead of a bare
 * timeout, since comparing presets at all requires a debug build.
 */
export async function selectPreset(presetId: string): Promise<void> {
    const label = PRESET_LABELS[presetId];
    if (!label) throw new Error(`Unknown preset id: ${presetId}`);

    await openFileMenuItem('Settings');

    const radio = $(`//label[.//p[normalize-space(text()[1]) = "${label}"]]//input[@type="radio"]`);
    const singlePresetInfo = $('*=Anchor runs the');

    await browser.waitUntil(
        async () => (await radio.isExisting()) || (await singlePresetInfo.isExisting()),
        {
            timeout: 10_000,
            timeoutMsg: 'Settings ▸ Pipeline never rendered a preset radio or the single-preset fallback text',
        },
    );

    if (await radio.isExisting()) {
        if (!(await radio.isSelected())) {
            await radio.click();
            await browser.waitUntil(() => radio.isSelected(), {
                timeout: 10_000,
                timeoutMsg: `preset "${presetId}" (label "${label}") did not become selected`,
            });
        }
    } else {
        const text = await singlePresetInfo.getText();
        if (!text.includes(label)) {
            throw new Error(
                `This build only offers one pipeline preset ("${text}"), and it is not ` +
                    `"${presetId}" (${label}). Comparing presets needs a debug build — see ` +
                    `docs/TESTING.md's pipeline-accuracy eval section.`,
            );
        }
        // The build's one preset already matches what was requested — nothing to select.
    }

    await resetToDashboard();
}

/** Returns to the Dashboard (File ▸ New Extraction) so the next image's file input
 *  is available. Called after selecting a preset and after every scored image. */
export async function resetToDashboard(): Promise<void> {
    await openFileMenuItem('New Extraction');
    await (await $('input[type="file"]')).waitForExist({ timeout: 10_000 });
}
