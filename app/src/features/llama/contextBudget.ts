// Prompt-size budgeting for Stage 1 extraction.
//
// The extraction prompt (base64 image + spatial OCR text + instructions) and the
// generated table all share llama-server's fixed context window (`-c`). A dense
// multi-column page can produce enough spatial text that the prompt alone crowds
// out the output — or doesn't fit at all — which previously failed silently as a
// truncated/empty table with no explanation (design review F3). These helpers give
// a cheap, conservative estimate so the caller can clamp the output budget and warn
// the user before spending a minute of inference on a page that can't fit.

// Mirrors DEFAULT_CTX_SIZE in src-tauri/src/llama.rs. Keep in sync if the server's
// `-c` argument changes (or, later, varies per hardware tier).
export const CONTEXT_SIZE = 8192;

// Mirrors DEFAULT_IMAGE_MIN_TOKENS in src-tauri/src/llama.rs — the floor the vision
// projector emits for the image. The real cost can be higher for large renders, so
// treating the floor as the estimate is deliberately optimistic; the headroom
// reserve below absorbs the slack.
export const IMAGE_TOKEN_ESTIMATE = 1024;

// Smallest output budget worth attempting. If the prompt leaves less than this, the
// page is effectively too big to extract in one pass.
export const MIN_OUTPUT_TOKENS = 256;

// Rough token count. English BPE averages ~4 characters per token; this is only ever
// used to decide "does this plausibly fit", so an approximate count is sufficient and
// far cheaper than shipping a real tokenizer.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export type ContextBudget = {
    /** Estimated prompt tokens (image + text). */
    promptTokens: number;
    /** Output tokens that actually fit after the prompt, clamped to the context. */
    availableOutputTokens: number;
    /** True when the prompt leaves less than MIN_OUTPUT_TOKENS of headroom. */
    overflow: boolean;
};

// Estimate the prompt footprint and how much output room is left in the context.
export const estimateExtractionBudget = (promptText: string): ContextBudget => {
    const promptTokens = IMAGE_TOKEN_ESTIMATE + estimateTokens(promptText);
    const availableOutputTokens = Math.max(0, CONTEXT_SIZE - promptTokens);
    return {
        promptTokens,
        availableOutputTokens,
        overflow: availableOutputTokens < MIN_OUTPUT_TOKENS,
    };
};
