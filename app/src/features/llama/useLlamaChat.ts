import { useState, useRef } from "react";
import { useContext } from "react";
import { LlamaChatContext } from "./LlamaChatContext";
import { readFileAsBase64, buildGbnfGrammar, computeMaxTokens } from "./promptUtils";
import { streamTableExtraction } from "./llamaClient";
import { getDb } from "../../lib/db";
import { sortWords, formatIndexedOcrWordList, getRowBands, getWordIndicesInBand } from "../../utils/ocrTransforms";
import {
    parsePipeFormat,
    splitHeaderAndData,
    validateRefs,
    expandSpans,
    mapLogprobsToCells,
    aggregateOcrConfidence,
    classifyAgreement,
    cellTrust,
    rawCellsToCSV,
} from "../extraction/pipeFormat";
import type {
    ValidatedCell,
    CellLogprobs,
    Agreement,
    TrustLevel,
} from "../extraction/pipeFormat";
import type { OcrWord } from "../ocr/types";

export type ExtractionData = {
    csvString: string;
    validatedRows: ValidatedCell[][];  // row[0] is the header row
    trustLevels: TrustLevel[][];
    ocrConfidences: (number | null)[][];
    agreements: Agreement[][];
    cellLogprobs: CellLogprobs[][];
    sortedWords: OcrWord[];            // for provenance bbox lookup
};

export const useLlamaChat = () => {
    const context = useContext(LlamaChatContext);

    if (!context) {
        throw new Error("useLlamaChat must be used within a LlamaChatProvider.");
    }

    const [extractionData, setExtractionData] = useState<ExtractionData | null>(null);
    const [isExtracting, setIsExtracting] = useState(false);
    const [streamingContent, setStreamingContent] = useState("");
    const extractionAbortRef = useRef<AbortController | null>(null);

    const clearExtraction = () => {
        extractionAbortRef.current?.abort();
        setExtractionData(null);
        setStreamingContent("");
    };

    const requestTableFormat = async (
        fileUrl: string,
        ocrWords: OcrWord[],
        imageHeight: number,
        sessionId: string,
        pageIndex: number,
    ) => {
        if (!context.isServerReady) {
            await context.startServer();
        }

        extractionAbortRef.current?.abort();
        extractionAbortRef.current = new AbortController();
        setIsExtracting(true);
        setExtractionData(null);
        setStreamingContent("");

        try {
            // Fetch and encode the page image
            const response = await fetch(fileUrl);
            const blob = await response.blob();
            const file = new File([blob], "source_document.png", { type: blob.type });
            const imageBase64 = await readFileAsBase64(file);
            const imageType = blob.type || "image/png";

            // Sort words into reading order; strip pipe characters before ID
            // assignment — a literal "|" in the word list collides with the
            // value|wordId delimiter, and OCR regularly reads column-rule lines
            // as "|" glyphs. Filtering here keeps prompt IDs and all downstream
            // index references (validateRefs, bbox lookup) consistent.
            const sorted = sortWords(ocrWords, imageHeight)
                .map(w => ({ ...w, text: w.text.replace(/^\|+|\|+$/g, "").trim() }))
                .filter(w => w.text.length > 0);
            const ocrWordList = formatIndexedOcrWordList(sorted, imageHeight);

            // DEBUG: verify image encoding and OCR word list before sending to the model.
            // Check that 1299E-style tokens aren't split, IDs are sequential, format matches spec.
            console.log("[extraction] imageType:", imageType, "| base64 length:", imageBase64.length, "| base64 prefix:", imageBase64.slice(0, 20));
            console.log("[extraction] ocrWordList:\n" + ocrWordList);

            // Estimate table dimensions for the max_tokens budget
            const rowBands = getRowBands(sorted, imageHeight);
            const estimatedRows = Math.max(rowBands.length + 1, 2); // +1 for header

            // OCR word count per line (used only for token budget, not column count).
            // Multi-word cell values (e.g. "LNR ALG NUM ANALYSIS FOR ENG" = 6 words, 1 cell)
            // make max-words-per-line a severe overestimate of the true column count.
            // Using it for the grammar column count causes the model to pad short rows with
            // repeated and incorrect values. Variable-column grammar §4.2 lets the model
            // determine the column count from the image; presence_penalty (set in llamaClient)
            // is what prevents the repetition loop — not a fixed column count.
            const estimatedCols = Math.min(Math.max(...rowBands.map(b => getWordIndicesInBand(sorted, b).length), 1), 20);
            const grammar = buildGbnfGrammar();                        // variable-column §4.2
            const maxTokens = computeMaxTokens(estimatedRows, estimatedCols);

            const { rawOutput, tokenLogprobs } = await streamTableExtraction({
                imageBase64,
                imageType,
                ocrWordList,
                grammar,
                maxTokens,
                onContentDelta: setStreamingContent,
                signal: extractionAbortRef.current.signal,
            });

            // ---------------------------------------------------------------
            // Post-processing pipeline (§6 → §8)
            // ---------------------------------------------------------------
            const rawRows = parsePipeFormat(rawOutput);
            if (rawRows.length === 0) return;

            const { header, data } = splitHeaderAndData(rawRows);
            const allRows = [header, ...data];

            const validated = validateRefs(allRows, sorted);
            const expanded = expandSpans(validated, sorted, imageHeight);
            const cellLogprobs = mapLogprobsToCells(rawOutput, tokenLogprobs, allRows);
            const ocrConfidences = aggregateOcrConfidence(expanded, sorted);

            const agreements: Agreement[][] = expanded.map(row =>
                row.map(cell => classifyAgreement(cell, sorted))
            );
            const trustLevels: TrustLevel[][] = expanded.map((row, ri) =>
                row.map((_, ci) => cellTrust(
                    agreements[ri][ci],
                    cellLogprobs[ri]?.[ci]?.llmConfidence ?? 0,
                    cellLogprobs[ri]?.[ci]?.llmMinTokenProb ?? 0,
                    ocrConfidences[ri]?.[ci] ?? null,
                ))
            );

            const csvString = rawCellsToCSV(expanded);

            // Save to DB (same table as the old pipeline)
            try {
                const db = await getDb();
                await db.execute(
                    `INSERT INTO csv_outputs (id, session_id, page_index, csv_content)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT(session_id, page_index) DO UPDATE SET csv_content = excluded.csv_content, created_at = CURRENT_TIMESTAMP`,
                    [crypto.randomUUID(), sessionId, pageIndex, csvString],
                );
            } catch (err) {
                console.error("Failed to save CSV output:", err);
            }

            setExtractionData({
                csvString,
                validatedRows: expanded,
                trustLevels,
                ocrConfidences,
                agreements,
                cellLogprobs,
                sortedWords: sorted,
            });
        } finally {
            setIsExtracting(false);
            setStreamingContent("");
        }
    };

    return {
        ...context,
        requestTableFormat,
        extractionData,
        isExtracting,
        streamingContent,
        clearExtraction,
    };
};
