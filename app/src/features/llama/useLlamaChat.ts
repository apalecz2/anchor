import { useContext, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LlamaChatContext } from "./LlamaChatContext";
import { getDb } from '../../lib/db';
import { touchSession } from '../sessions/touchSession';
import { matchCellsToOcr } from '../extraction/provenance';
import { parseTSVWithOffsets, computeProvenanceCells } from '../extraction/confidence';
import { toCsv } from '../export/exportUtils';
import { readSetting } from '../../lib/settings';
import type { OcrWord } from '../ocr/types';
import type { DeclaredGrid, GroundingKind, ProvenanceCell, TokenLogprob } from '../extraction/types';

type TableFormatResult = {
    csvContent: string;
    provenanceCells: ProvenanceCell[][];
    sanitizedWords: OcrWord[];
    /** How precisely this page's cells can be traced back to the image — drives the
     *  document highlight's precision as well as the trust axis above. */
    grounding: GroundingKind;
    /** True when the model hit its token budget (`finish_reason: "length"`) and
     *  the table is likely missing trailing rows/cells. */
    truncated: boolean;
    /** True when the prompt (image + spatial OCR text) is estimated to leave too
     *  little of the context window for a complete table — a dense page that can't
     *  reliably fit in one pass. Surfaced so the user understands a partial result. */
    contextOverflow: boolean;
};

/**
 * What the Rust executor hands back for one page: the inputs the scoring stages
 * need, and nothing they could derive for themselves.
 *
 * `groundedItems` are the words the model was *actually shown*, in the order it saw
 * them — returned rather than re-derived here, because matching cells against a
 * separately-derived list is how provenance silently mismatches.
 */
type PageArtifact = {
    run_id: number;
    preset_id: string;
    preset_version: number;
    grounding: GroundingKind;
    grounded_items: OcrWord[];
    /** Row/column bands a grounding model reported, already in page pixels. Absent on
     *  every preset that ships today — Tesseract supplies words, not bands. */
    grid?: DeclaredGrid | null;
    raw_model_output: string;
    logprobs: TokenLogprob[];
    finish_reason: string | null;
    truncated: boolean;
    context_overflow: boolean;
};

/** Coarse stage of an in-flight extraction, surfaced so the UI can show the user
 *  exactly what is happening (model load can take a while on first run). */
export type ExtractionPhase = 'idle' | 'starting' | 'preparing' | 'generating' | 'finalizing';

/** Backend cancellation sentinel — must match CANCELLED_MESSAGE in
 *  src-tauri/src/pipeline/client.rs. A cancel is a neutral state, not a failure. */
const CANCELLED_MESSAGE = 'Extraction was cancelled.';

/** Map a pipeline step to the phase the progress stepper already renders. The
 *  executor also sends a human-readable label per step; the stepper doesn't use it
 *  yet, which is what keeps this cutover behaviour-identical. */
const PHASE_FOR_STEP: Record<string, ExtractionPhase> = {
    render: 'preparing',
    ground_tesseract: 'preparing',
    ground_model: 'preparing',
    // Mapping the table runs a model, but it is still preparation for the table the
    // user is waiting to see — 'generating' is the phase where output starts arriving.
    ground_grid: 'preparing',
    structure: 'generating',
    verify: 'generating',
};

export const useLlamaChat = () => {
    const context = useContext(LlamaChatContext);

    if (!context) {
        throw new Error("useLlamaChat must be used within a LlamaChatProvider.");
    }

    const [streamingContent, setStreamingContent] = useState<string>('');
    const [isExtracting, setIsExtracting] = useState(false);
    const [extractionPhase, setExtractionPhase] = useState<ExtractionPhase>('idle');
    // Set the instant Cancel is clicked so the UI can acknowledge it immediately,
    // even though the abort itself may take a moment to unwind (tearing down the
    // streaming request, or finishing a non-abortable phase such as a model load).
    const [isCancelling, setIsCancelling] = useState(false);
    // True while a run is in flight, so a cancel knows there is something to cancel.
    const runningRef = useRef(false);

    // Ask the backend to abort the in-flight run. The executor races cancellation
    // against the streaming read, so this stops mid-token rather than at the next
    // page boundary.
    const cancelTableFormat = () => {
        if (!runningRef.current) return;
        setIsCancelling(true);
        void invoke('cancel_extraction_pipeline').catch(err =>
            console.error('Failed to cancel extraction:', err),
        );
    };

    const requestTableFormat = async (
        _fileUrl: string,
        ocrWords: OcrWord[],
        naturalWidth: number,
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
        runningRef.current = true;

        // Deltas arrive as increments; the pane wants the accumulated text.
        let streamed = '';
        const unlisten: Array<() => void> = [];

        try {
            const imagePath = await resolvePageImagePath(sessionId, pageIndex);

            unlisten.push(
                await listen<{ kind: string }>('pipeline:step', event => {
                    const phase = PHASE_FOR_STEP[event.payload.kind];
                    if (phase) setExtractionPhase(phase);
                }),
            );
            unlisten.push(
                await listen<{ text_delta: string }>('pipeline:delta', event => {
                    streamed += event.payload.text_delta;
                    setStreamingContent(streamed);
                }),
            );

            // Stage 1 — the executor derives the prompt inputs, ensures the right
            // model is resident, and streams the completion.
            const artifact = await invoke<PageArtifact>('run_extraction_pipeline', {
                presetId: null, // the catalog's default until a picker exists
                pageIndex,
                imagePath,
                words: ocrWords,
                // Both dimensions: a grounding model reports boxes normalized 0–1000
                // per axis, so converting them to page pixels needs the width too.
                naturalWidth,
                naturalHeight,
                backend: readSetting('hardwareBackend'),
                boostTokens: options?.boostTokens ?? false,
            });

            setExtractionPhase('finalizing');

            // Stage 2 — parse, match to source, score confidence, persist. Unchanged:
            // these stay in TypeScript because they are pure and heavily tested.
            const { rows: csvRows } = parseTSVWithOffsets(artifact.raw_model_output);
            if (csvRows.length === 0) {
                throw new Error('The model did not return a parseable table. Try re-extracting, or check that the page contains tabular data.');
            }

            // Matching runs against the exact list the model was shown, handed back by
            // the executor — not a list re-derived here, which could differ.
            // The grounding tier is the preset's, not a guess: it selects where the
            // table grid comes from and which agreement axis the heatmap scores on.
            const sanitizedWords = artifact.grounded_items;
            const cellProvenance = matchCellsToOcr(csvRows, sanitizedWords, naturalHeight, {
                grounding: artifact.grounding,
                grid: artifact.grid,
            });
            const provenanceCells = computeProvenanceCells(
                cellProvenance,
                artifact.logprobs,
                artifact.raw_model_output,
                sanitizedWords,
                artifact.grounding,
            );

            // Re-serialize a clean, correctly-escaped CSV from the parsed rows. Use the
            // canonical exporter (RFC-4180 quoting) so cells containing quotes/newlines —
            // not just commas — round-trip through parseCSV/export without corruption.
            const csvContent = toCsv(csvRows);

            const db = await getDb();
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
            // Record which pipeline produced this, so reopening the session renders it
            // the way it was produced rather than the way today's default would.
            await db.execute(
                `INSERT INTO page_extraction_meta (session_id, page_index, preset_id, preset_version, grounding)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT(session_id, page_index) DO UPDATE SET
                   preset_id = excluded.preset_id,
                   preset_version = excluded.preset_version,
                   grounding = excluded.grounding`,
                [sessionId, pageIndex, artifact.preset_id, artifact.preset_version, artifact.grounding]
            );
            // A completed extraction is the clearest "activity" signal, so surface it
            // in the session's last-updated time that "Recent" and Search order by.
            await touchSession(sessionId);

            return {
                csvContent,
                provenanceCells,
                sanitizedWords,
                grounding: artifact.grounding,
                truncated: artifact.truncated,
                contextOverflow: artifact.context_overflow,
            };
        } catch (err) {
            // Tauri rejects invoke() with a plain string, not an Error.
            const message =
                err instanceof Error ? err.message
                : typeof err === 'string' ? err
                : 'Extraction failed.';
            // A user-initiated cancel is not a failure. Re-thrown as an AbortError so
            // the caller's existing cancel handling applies unchanged.
            if (message === CANCELLED_MESSAGE) {
                throw new DOMException(message, 'AbortError');
            }
            throw new Error(message);
        } finally {
            for (const stop of unlisten) stop();
            runningRef.current = false;
            setIsExtracting(false);
            setExtractionPhase('idle');
            setIsCancelling(false);
            setStreamingContent('');
            // Release the model with a short warm window instead of unloading now: a
            // re-extract or next page within that window skips the multi-GB reload,
            // while an idle session still frees RAM (design §6). The executor starts
            // the server; the idle unload is still scheduled from here.
            context.releaseServer();
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

/**
 * Absolute path of a page's rendered image.
 *
 * The executor reads the file itself rather than being handed base64 over IPC — a
 * 2000px page is several megabytes, and routing it through the bridge only to hand
 * it back to a local process is pure overhead.
 */
const resolvePageImagePath = async (sessionId: string, pageIndex: number): Promise<string> => {
    const db = await getDb();
    const rows = await db.select<{ image_path: string }[]>(
        'SELECT image_path FROM document_pages WHERE session_id = $1 AND page_index = $2',
        [sessionId, pageIndex],
    );
    const path = rows?.[0]?.image_path;
    if (!path) throw new Error('This page has not been processed yet.');
    return path;
};
