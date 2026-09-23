/**
 * Mirrors `app/src-tauri/src/pipeline/catalog.rs` PRESETS (debug-build list) and
 * `DEFAULT_PRESET_ID` — update both sides if either changes. Kept as pure data
 * (no WebdriverIO import) so `config.ts` can validate/default against it without
 * pulling a browser-driving dependency into env-var parsing.
 */
export const PRESET_LABELS: Record<string, string> = {
    'oar-ocr-surya-qwen3.5-4b': 'Accurate (Rust OCR)',
    'tesseract-surya-qwen3.5-4b': 'Accurate',
    'oar-ocr-qwen3.5-4b': 'Fast (Rust OCR)',
    'tesseract-qwen3.5-4b': 'Fast (Tesseract)',
    'oar-ocr-surya-no-llm': 'Rust OCR + Surya (no LLM)',
};

export const ALL_PRESET_IDS = Object.keys(PRESET_LABELS);

/** Mirrors catalog.rs's debug-build DEFAULT_PRESET_ID. */
export const DEFAULT_PRESET_ID = 'oar-ocr-qwen3.5-4b';
