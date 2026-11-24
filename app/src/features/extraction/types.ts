import type { OcrWord } from '../ocr/types';

export type FileAttachment = {
    name: string;
    type: string;
    data: string;
};

export type { BoundingBox, OcrWord } from '../ocr/types';

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
    id: number;
    role: ChatRole;
    content: string;
    thinking?: string;
    isThinkingOpen?: boolean;
    isStreaming?: boolean;
    attachments?: FileAttachment[];
};

export interface DocumentPageResult {
    image_path: string;
    natural_width: number;
    natural_height: number;
    words: OcrWord[];
    text: string;
    /** Set when this page failed to render/OCR; the rest of the document still
     *  processed. Absent on successful pages. */
    error?: string | null;
}

export interface ExtractionResult {
    session_id: string;
    pages: DocumentPageResult[];
}

export interface LineWord {
    text: string;
    wordId: string;
}

export type CellProvenance = {
    rowIndex: number;
    colIndex: number;
    value: string;
    wordIds: string[];      // stable OcrWord UUIDs (OcrWord.id) — survive add/edit/delete reordering
    // "empty" = the cell is blank in the TSV. For empty cells wordIds are not
    // source words: when non-empty they are *overlooked* words — unclaimed OCR
    // text found inside the cell's region, i.e. the model may have dropped
    // content there. wordIds empty means no such text was found (or the region
    // could not be located). Sessions persisted before "empty" existed store
    // blank cells as "unmatched"; consumers treat a blank value as empty too.
    matchStatus: "matched" | "multi_word" | "fuzzy" | "unmatched" | "empty";
    // Manual review state. `verified` = the user confirmed this cell against the
    // source (it leaves the review worklist and renders with a ✓); `edited` = the
    // value was hand-corrected (an edit implies verified). Both are absent on
    // sessions persisted before manual review existed — treat missing as false.
    verified?: boolean;
    edited?: boolean;
};

export type TokenLogprob = {
    token: string;
    // null when llama.cpp returned a token without a logprob (e.g. logprobs absent
    // for that delta). Confidence scoring excludes nulls from the mean rather than
    // treating them as logprob 0 (= probability 1.0), which would silently inflate
    // trust to maximum for the very tokens we have no confidence signal for.
    logprob: number | null;
    charOffset: number;     // cumulative char offset in the raw streamed content
};

/**
 * How precisely the source of a cell can be located on the page — the `Grounding`
 * enum in `src-tauri/src/pipeline/catalog.rs`, mirrored here because the executor
 * reports it on every artifact and it decides three things in the frontend: whether
 * provenance infers the table grid or is handed one, which agreement axis confidence
 * scores on, and how precisely the document highlight can be drawn.
 *
 *  - `word`  — per-word boxes (Tesseract). Today's only shipped tier.
 *  - `cell`  — row × column bands the grounding model reported directly.
 *  - `block` — region boxes only. Honest, but coarse: the P0 spike saw a whole
 *              transcript come back as one block, which is why no preset relies on it.
 *  - `none`  — no locations at all; the structuring model is the only source.
 */
export type GroundingKind = "none" | "block" | "word" | "cell";

/** An inclusive 1-D interval in page pixels. */
export type Span = { lo: number; hi: number };

/**
 * A table grid the grounding model reported, rather than one inferred from word
 * geometry. Arrives on the page artifact already converted to page pixels (see
 * `pipeline/surya.rs`), so only one coordinate space is ever in play here.
 */
export type DeclaredGrid = {
    rowBands: Span[];
    colBands: Span[];
};

/**
 * How the two sources of a cell relate.
 *
 * The axis is "**structure source vs grounding source**", not "LLM vs Tesseract" —
 * which is what it always modelled, and what lets a model-grounded, model-verified
 * page still earn `high`.
 *
 *  - `agree`         — the structured value was found in the grounded source.
 *  - `disagree`      — the sources conflict (today: a blank cell over a region that
 *                      still holds unclaimed text).
 *  - `image_only`    — grounding found nothing matching this value.
 *  - `self_reported` — there is no second source *by design* (`none` grounding), so
 *                      the model is vouching for itself. Capped at `medium`.
 */
export type AgreementStatus = "agree" | "disagree" | "image_only" | "self_reported";
export type TrustLevel = "high" | "medium" | "low";

export type CellConfidence = {
    // 0–1, geometric mean / minimum of per-token probs. null when the cell has no
    // usable *value* logprob — e.g. its entire content arrived as a single
    // boundary-merged token (a leading "\t"/"\n" fused onto the word), whose
    // probability reflects tokenizer segmentation, not value certainty. null means
    // "unscored by the LLM" (render neutral), distinct from a real low score.
    llmMean: number | null;
    llmMin: number | null;
    ocr: number | null;     // 0–100, mean OCR confidence of matched words; null if unmatched
    agreement: AgreementStatus;
    trust: TrustLevel;
};

export type ProvenanceCell = CellProvenance & { confidence: CellConfidence };