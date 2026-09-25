/**
 * Mirrors `app/src-tauri/src/pipeline/catalog.rs` PRESETS (debug-build list) and
 * `DEFAULT_PRESET_ID` — update both sides if either changes. Kept as pure data
 * (no WebdriverIO import) so `config.ts` can validate/default against it without
 * pulling a browser-driving dependency into env-var parsing.
 *
 * The three Surya-grounded presets (`oar-ocr-surya-qwen3.5-4b`,
 * `tesseract-surya-qwen3.5-4b`, `oar-ocr-surya-no-llm`) were removed from `PRESETS`
 * (an unresolved license concern, plus this harness's own eval finding that Surya's
 * grid step didn't earn its keep — see `catalog::SURYA_OCR_2`'s doc comment) and are
 * no longer selectable in any build, so they're gone from here too.
 */
export const PRESET_LABELS: Record<string, string> = {
    'oar-ocr-qwen3.5-4b': 'Fast (Rust OCR)',
    'tesseract-qwen3.5-4b': 'Fast (Tesseract)',
};

export const ALL_PRESET_IDS = Object.keys(PRESET_LABELS);

/** Mirrors catalog.rs's debug-build DEFAULT_PRESET_ID. */
export const DEFAULT_PRESET_ID = 'oar-ocr-qwen3.5-4b';
