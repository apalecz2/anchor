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
    matchStatus: "matched" | "multi_word" | "fuzzy" | "unmatched";
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

export type AgreementStatus = "agree" | "disagree" | "image_only";
export type TrustLevel = "high" | "medium" | "low";

export type CellConfidence = {
    llmMean: number;        // 0–1, geometric mean of per-token probs
    llmMin: number;         // 0–1, minimum per-token prob
    ocr: number | null;     // 0–100, mean OCR confidence of matched words; null if unmatched
    agreement: AgreementStatus;
    trust: TrustLevel;
};

export type ProvenanceCell = CellProvenance & { confidence: CellConfidence };