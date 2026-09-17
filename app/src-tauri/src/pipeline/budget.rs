//! Prompt-size budgeting for a model step.
//!
//! A port of `app/src/features/llama/contextBudget.ts`, with one structural change:
//! the context size and image-token floor are read from the model's catalog entry
//! instead of being constants hand-mirrored between Rust and TypeScript. That
//! duplication was already flagged in the TypeScript ("Keep in sync if the server's
//! `-c` argument changes"), and it stops being possible to get wrong once a second
//! model with a different context window exists.
//!
//! The prompt (image + spatial OCR text) and the generated table share one context
//! window. A dense page can produce enough spatial text that the prompt crowds out
//! the output — or doesn't fit at all — which previously failed silently as a
//! truncated or empty table. These estimates are deliberately cheap and slightly
//! optimistic; the caller uses them to clamp the output budget and to warn before
//! spending a minute of inference on a page that cannot fit.

use crate::pipeline::catalog::ModelSpec;

/// Smallest output budget worth attempting. Below this the page is effectively too
/// dense to extract in one pass.
pub const MIN_OUTPUT_TOKENS: u32 = 256;

/// Output tokens to budget per table cell; word count stands in for table density.
const TOKENS_PER_CELL: u32 = 4;

/// Rough token count. English BPE averages ~4 characters per token, and this only
/// ever decides "does this plausibly fit", so an approximation is enough and far
/// cheaper than shipping a real tokenizer.
///
/// Counts UTF-16 code units, matching the JavaScript `text.length / 4` this mirrors
/// — the same measurement rule as the rest of the prompt derivation.
pub fn estimate_tokens(text: &str) -> u32 {
    let units = text.encode_utf16().count();
    units.div_ceil(4) as u32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextBudget {
    /// Estimated prompt tokens (image + text).
    pub prompt_tokens: u32,
    /// Output tokens that actually fit after the prompt, clamped to the context.
    pub available_output_tokens: u32,
    /// True when the prompt leaves less than [`MIN_OUTPUT_TOKENS`] of headroom.
    pub overflow: bool,
}

/// Estimate the prompt footprint and how much output room the model's context leaves.
///
/// A model with no vision projector contributes no image tokens, so a text-only
/// grounding step gets its full window for text rather than losing a phantom
/// kilobyte to an image it was never sent.
pub fn estimate_budget(model: &ModelSpec, prompt_text: &str) -> ContextBudget {
    let image_tokens = if model.caps.vision {
        model.launch.image_min_tokens.unwrap_or(0)
    } else {
        0
    };
    let prompt_tokens = image_tokens + estimate_tokens(prompt_text);
    let available_output_tokens = model.launch.ctx.saturating_sub(prompt_tokens);
    ContextBudget {
        prompt_tokens,
        available_output_tokens,
        overflow: available_output_tokens < MIN_OUTPUT_TOKENS,
    }
}

/// How many output tokens to request for one extraction.
///
/// Budgets ~4 tokens per cell using the word count as a density proxy, then clamps to
/// the room the prompt actually leaves — asking for more output than fits merely
/// guarantees a `length` truncation. `boost` requests the whole remaining window
/// instead, which is the opt-in retry after a truncated table.
pub fn resolve_max_tokens(budget: ContextBudget, word_count: usize, boost: bool) -> u32 {
    let desired = MIN_OUTPUT_TOKENS.max((word_count as u32).saturating_mul(TOKENS_PER_CELL));
    let target = if boost {
        budget.available_output_tokens
    } else {
        desired
    };
    MIN_OUTPUT_TOKENS.max(target.min(budget.available_output_tokens))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::catalog::QWEN_3_5_4B;

    #[test]
    fn estimate_tokens_rounds_up_by_four_characters() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    /// Same UTF-16 rule as the rest of the prompt derivation: a 6-unit string is 6
    /// units even though it is 7 UTF-8 bytes.
    #[test]
    fn estimate_tokens_counts_utf16_units_not_bytes() {
        assert_eq!("Crédit".len(), 7);
        assert_eq!(estimate_tokens("Crédit"), 2); // ceil(6/4), not ceil(7/4)
    }

    /// The values the TypeScript used as constants, now derived from the catalog.
    #[test]
    fn qwen_budget_matches_the_previous_hardcoded_constants() {
        let budget = estimate_budget(&QWEN_3_5_4B, "");
        assert_eq!(budget.prompt_tokens, 1024); // IMAGE_TOKEN_ESTIMATE
        assert_eq!(budget.available_output_tokens, 8192 - 1024); // CONTEXT_SIZE
        assert!(!budget.overflow);
    }

    #[test]
    fn a_prompt_that_crowds_out_the_output_is_flagged_as_overflow() {
        let huge = "x".repeat(4 * 8192);
        let budget = estimate_budget(&QWEN_3_5_4B, &huge);
        assert_eq!(budget.available_output_tokens, 0);
        assert!(budget.overflow);
    }

    /// Saturating arithmetic, not a panic or a wrap, when the prompt exceeds the
    /// whole window.
    #[test]
    fn an_oversized_prompt_yields_zero_rather_than_underflowing() {
        let budget = estimate_budget(&QWEN_3_5_4B, &"x".repeat(4 * 100_000));
        assert_eq!(budget.available_output_tokens, 0);
    }

    #[test]
    fn max_tokens_scales_with_word_count_but_respects_the_floor() {
        let budget = estimate_budget(&QWEN_3_5_4B, "");
        // 10 words * 4 = 40, below the floor.
        assert_eq!(resolve_max_tokens(budget, 10, false), MIN_OUTPUT_TOKENS);
        // 200 words * 4 = 800, above the floor and within the window.
        assert_eq!(resolve_max_tokens(budget, 200, false), 800);
    }

    #[test]
    fn max_tokens_never_exceeds_what_the_prompt_leaves() {
        let budget = estimate_budget(&QWEN_3_5_4B, "");
        // A word count whose naive budget far exceeds the remaining window.
        let capped = resolve_max_tokens(budget, 100_000, false);
        assert_eq!(capped, budget.available_output_tokens);
    }

    #[test]
    fn boost_requests_the_whole_remaining_window() {
        let budget = estimate_budget(&QWEN_3_5_4B, "");
        assert_eq!(
            resolve_max_tokens(budget, 10, true),
            budget.available_output_tokens
        );
    }

    /// A text-only model is sent no image, so it should not be charged for one.
    #[test]
    fn a_model_without_vision_is_not_charged_image_tokens() {
        let mut text_only = QWEN_3_5_4B;
        text_only.caps.vision = false;
        let budget = estimate_budget(&text_only, "");
        assert_eq!(budget.prompt_tokens, 0);
        assert_eq!(budget.available_output_tokens, 8192);
    }
}
