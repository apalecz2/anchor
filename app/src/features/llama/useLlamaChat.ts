import { useContext, useRef, useState } from "react";
import { LlamaChatContext } from "./LlamaChatContext";
import { readFileAsBase64 } from './promptUtils';
import { extractTableFromImage } from './llamaClient';
import { estimateExtractionBudget, MIN_OUTPUT_TOKENS } from './contextBudget';
import { getDb } from '../../lib/db';
import { buildTableText } from '../../utils/ocrTransforms';
import { sanitizeWordsForProvenance } from '../extraction/provenance';
import { matchCellsToOcr } from '../extraction/provenance';
import { parseTSVWithOffsets, computeProvenanceCells } from '../extraction/confidence';
import { toCsv } from '../export/exportUtils';
import type { OcrWord } from '../ocr/types';
import type { ProvenanceCell } from '../extraction/types';

type TableFormatResult = {
    csvContent: string;
    provenanceCells: ProvenanceCell[][];
    sanitizedWords: OcrWord[];
    /** True when the model hit its token budget (`finish_reason: "length"`) and
     *  the table is likely missing trailing rows/cells. */
    truncated: boolean;
    /** True when the prompt (image + spatial OCR text) is estimated to leave too
     *  little of the context window for a complete table — a dense page that can't
     *  reliably fit in one pass. Surfaced so the user understands a partial result. */
    contextOverflow: boolean;
};

/** Coarse stage of an in-flight extraction, surfaced so the UI can show the user
 *  exactly what is happening (model load can take a while on first run). */
export type ExtractionPhase = 'idle' | 'starting' | 'preparing' | 'generating' | 'finalizing';

export const useLlamaChat = () => {
    const context = useContext(LlamaChatContext);

    if (!context) {
        throw new Error("useLlamaChat must be used within a LlamaChatProvider.");
    }

    const [streamingContent, setStreamingContent] = useState<string>('');
    const [isExtracting, setIsExtracting] = useState(false);
    const [extractionPhase, setExtractionPhase] = useState<ExtractionPhase>('idle');
    // Set the instant Cancel is clicked so the UI can acknowledge it immediately,
    // even though the abort itself may take a moment to unwind the in-flight request
    // (e.g. tearing down the streaming fetch, or finishing a non-abortable phase).
    const [isCancelling, setIsCancelling] = useState(false);
    // Holds the in-flight extraction's AbortController so the user can cancel it.
    // Aborting rejects the streaming fetch (and our explicit checkpoints) with an
    // AbortError, which the caller treats as a neutral cancel rather than a failure.
    const abortRef = useRef<AbortController | null>(null);

    // Abort an in-flight table extraction. Flips isCancelling for instant feedback;
    // no-ops when nothing is running so a stray click can't strand the cancelling UI.
    const cancelTableFormat = () => {
        if (!abortRef.current) return;
        setIsCancelling(true);
        abortRef.current.abort();
    };

    const requestTableFormat = async (
        fileUrl: string,
        ocrWords: OcrWord[],
        naturalHeight: number,
        sessionId: string,
        pageIndex: number,
        // When the user retries a truncated table, request the entire remaining
        // context window instead of the per-cell heuristic (which underestimated and
        // caused the truncation). Costs more memory/time, so it's opt-in per retry.
        options?: { boostTokens?: boolean },
    ): Promise<TableFormatResult> => {
        // Flip the in-flight flags up front (before any await) so the click responds
        // instantly and the UI can show progress while the model server loads — which
        // can take well over a minute on a cold first run.
        setIsExtracting(true);
        setStreamingContent('');
        setExtractionPhase('starting');
        setIsCancelling(false);

        // Fresh controller per run; cancelTableFormat() aborts it. Checked at each
        // phase boundary so a cancel during the long, un-abortable model load (or
        // image read) still stops promptly instead of finishing the whole extraction.
        const controller = new AbortController();
        abortRef.current = controller;
        const throwIfCancelled = () => {
            if (controller.signal.aborted) {
                throw new DOMException('Table formatting was cancelled.', 'AbortError');
            }
        };

        try {
            // Always go through startServer: it returns immediately when the server is
            // already warm (and cancels any pending idle unload from a prior extraction).
            // Passing the signal lets a cancel abandon the model-load wait promptly.
            const ready = await context.startServer(controller.signal);
            // Check cancellation before the failure path: a cancel makes startServer
            // return false, but that's a clean cancel — not a "failed to start" error.
            throwIfCancelled();
            if (!ready) {
                // startServer surfaces the specific reason via `serverError`; throw a
                // fallback so the caller still gets a message even on a stale read.
                throw new Error('The local model server failed to start. Check that the model files exist and you have enough free RAM, then retry.');
            }

            setExtractionPhase('preparing');
            // Stage 1 setup — sanitize words, build spatial layout text for the prompt
            const sanitizedWords = sanitizeWordsForProvenance(ocrWords, naturalHeight);
            const spatialText = buildTableText(sanitizedWords, naturalHeight);

            const prompt = [
                'Return only TSV (tab-separated values).',
                'First row must be the column headers.',
                'No reasoning, no explanation, no code fences, no markdown.',
                'Separate each column with a tab character. Do not use commas as delimiters.',
                'If two adjacent values belong to the same visual column (e.g. a department code and a course number), output them as one field joined by a space.',
                'Use the attached image as the primary reference and the OCR text below as a guide.',
                '',
                'OCR text:',
                spatialText,
            ].join('\n');

            // Budget ~4 tokens per cell; word count is a proxy for table density. Then
            // clamp to the context room the prompt actually leaves — asking for more
            // output than fits just guarantees a `length` truncation (design review F3).
            const TOKENS_PER_CELL = 4;
            const desiredTokens = Math.max(MIN_OUTPUT_TOKENS, sanitizedWords.length * TOKENS_PER_CELL);
            const budget = estimateExtractionBudget(prompt);
            // A boosted retry asks for the whole remaining window; a normal run uses the
            // per-cell estimate. Either way the value is capped to what actually fits.
            const targetTokens = options?.boostTokens ? budget.availableOutputTokens : desiredTokens;
            const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(targetTokens, budget.availableOutputTokens));
            const contextOverflow = budget.overflow;

            // Load image as base64
            const response = await fetch(fileUrl, { signal: controller.signal });
            const blob = await response.blob();
            const imageData = await readFileAsBase64(
                new File([blob], "page.png", { type: blob.type || 'image/png' })
            );

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'image_url' as const, image_url: { url: `data:${blob.type || 'image/png'};base64,${imageData}` } },
                    { type: 'text' as const, text: prompt },
                ],
            }];

            // Stage 1 — LLM extracts CSV from image + spatial OCR text
            setExtractionPhase('generating');
            const { content: rawContent, logprobs, finishReason } = await extractTableFromImage({
                messages,
                maxTokens,
                onContentDelta: setStreamingContent,
                signal: controller.signal,
            });

            // `finish_reason: "length"` means the model ran out of token budget before
            // emitting the full table — surface it so the user knows rows may be missing.
            const truncated = finishReason === 'length';

            // Stage 2 — parse, match to OCR, score confidence, persist.
            setExtractionPhase('finalizing');

            // A cancel that lands during generation may not interrupt the synchronous
            // finalize work below — bail before doing any of it (and before the DB write)
            // so a late cancel can't persist a table the user asked to discard.
            throwIfCancelled();

            // Parse the raw output while preserving char offsets for logprob mapping
            const { rows: csvRows } = parseTSVWithOffsets(rawContent);
            if (csvRows.length === 0) {
                throw new Error('The model did not return a parseable table. Try re-extracting, or check that the page contains tabular data.');
            }

            // Stage 2a — deterministic reading-order walk to match cells to OCR words
            const cellProvenance = matchCellsToOcr(csvRows, sanitizedWords);

            // Attach logprob-based + OCR-based confidence to each cell
            const provenanceCells = computeProvenanceCells(cellProvenance, logprobs, rawContent, sanitizedWords);

            // Re-serialize a clean, correctly-escaped CSV from the parsed rows. Use the
            // canonical exporter (RFC-4180 quoting) so cells containing quotes/newlines —
            // not just commas — round-trip through parseCSV/export without corruption.
            const csvContent = toCsv(csvRows);

            const db = await getDb();
            // Final checkpoint: a cancel that landed while the DB handle was awaited
            // must not still write the row (the await is the only yield point between
            // the earlier check and the insert).
            throwIfCancelled();
            // `created_at` is the row's first-write time and must NOT be rewritten on
            // re-extract — otherwise it tracks the latest extraction, not creation.
            // Last-activity tracking lives on sessions.updated_at, bumped below.
            await db.execute(
                `INSERT INTO csv_outputs (id, session_id, page_index, csv_content, cell_mappings_json)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT(session_id, page_index) DO UPDATE SET
                   csv_content = excluded.csv_content,
                   cell_mappings_json = excluded.cell_mappings_json`,
                [crypto.randomUUID(), sessionId, pageIndex, csvContent, JSON.stringify(provenanceCells)]
            );
            // A completed extraction is the clearest "activity" signal, so surface it
            // in the session's last-updated time that "Recent" and Search order by.
            await db.execute('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [sessionId]);

            // A cancel can land during the (non-abortable) DB writes above — the last
            // yield points before we return. Re-check here so the result is never
            // rendered into a pane the user asked to discard. The row is already a
            // complete, valid extraction, so we leave it persisted: re-entering the
            // page loads it rather than forcing a re-run of the work just finished.
            throwIfCancelled();

            return { csvContent, provenanceCells, sanitizedWords, truncated, contextOverflow };
        } finally {
            // Reset UI, then release the server with a short warm window instead of
            // unloading immediately: a re-extract or next page within that window
            // skips the multi-GB reload, while an idle session still frees RAM
            // (design §6). The model is unloaded outright on Session unmount.
            // Any error still propagates to the caller for display in the pane.
            setIsExtracting(false);
            setExtractionPhase('idle');
            setIsCancelling(false);
            setStreamingContent('');
            context.releaseServer();
            // Only clear the ref if a newer run hasn't already replaced it.
            if (abortRef.current === controller) abortRef.current = null;
        }
    };

    return {
        ...context,
        requestTableFormat,
        cancelTableFormat,
        streamingContent,
        isExtracting,
        isCancelling,
        extractionPhase,
    };
};
