import { useContext, useState } from "react";
import { LlamaChatContext } from "./LlamaChatContext";
import { readFileAsBase64 } from './promptUtils';
import { extractTableFromImage } from './llamaClient';
import { getDb } from '../../lib/db';
import { buildTableText } from '../../utils/ocrTransforms';
import { sanitizeWordsForProvenance } from '../extraction/provenance';
import { matchCellsToOcr } from '../extraction/provenance';
import { parseTSVWithOffsets, computeProvenanceCells } from '../extraction/confidence';
import type { OcrWord } from '../ocr/types';
import type { ProvenanceCell } from '../extraction/types';

type TableFormatResult = {
    csvContent: string;
    provenanceCells: ProvenanceCell[][];
    sanitizedWords: OcrWord[];
};

export const useLlamaChat = () => {
    const context = useContext(LlamaChatContext);

    if (!context) {
        throw new Error("useLlamaChat must be used within a LlamaChatProvider.");
    }

    const [streamingContent, setStreamingContent] = useState<string>('');
    const [isExtracting, setIsExtracting] = useState(false);

    const requestTableFormat = async (
        fileUrl: string,
        ocrWords: OcrWord[],
        naturalHeight: number,
        sessionId: string,
        pageIndex: number,
    ): Promise<TableFormatResult | null> => {
        if (!context.isServerReady) {
            await context.startServer();
        }

        setIsExtracting(true);
        setStreamingContent('');

        try {
            // Stage 1 setup — sanitize words, build spatial layout text for the prompt
            const sanitizedWords = sanitizeWordsForProvenance(ocrWords, naturalHeight);
            const spatialText = buildTableText(sanitizedWords, naturalHeight);

            // Budget ~4 tokens per cell; word count is a proxy for table density
            const TOKENS_PER_CELL = 4;
            const maxTokens = Math.max(256, sanitizedWords.length * TOKENS_PER_CELL);

            // Load image as base64
            const response = await fetch(fileUrl);
            const blob = await response.blob();
            const imageData = await readFileAsBase64(
                new File([blob], "page.png", { type: blob.type || 'image/png' })
            );

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

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'image_url' as const, image_url: { url: `data:${blob.type || 'image/png'};base64,${imageData}` } },
                    { type: 'text' as const, text: prompt },
                ],
            }];

            // Stage 1 — LLM extracts CSV from image + spatial OCR text
            const { content: rawContent, logprobs } = await extractTableFromImage({
                messages,
                maxTokens,
                onContentDelta: setStreamingContent,
            });

            // Parse the raw output while preserving char offsets for logprob mapping
            const { rows: csvRows } = parseTSVWithOffsets(rawContent);
            if (csvRows.length === 0) return null;

            // Stage 2a — deterministic reading-order walk to match cells to OCR words
            const cellProvenance = matchCellsToOcr(csvRows, sanitizedWords);

            // Attach logprob-based + OCR-based confidence to each cell
            const provenanceCells = computeProvenanceCells(cellProvenance, logprobs, rawContent, sanitizedWords);

            // Re-serialize a clean CSV from the parsed rows
            const csvContent = csvRows
                .map(row =>
                    row.map(cell => cell.includes(',') ? `"${cell.replace(/"/g, '""')}"` : cell).join(',')
                )
                .join('\n');

            const db = await getDb();
            await db.execute(
                `INSERT INTO csv_outputs (id, session_id, page_index, csv_content, cell_mappings_json)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT(session_id, page_index) DO UPDATE SET
                   csv_content = excluded.csv_content,
                   cell_mappings_json = excluded.cell_mappings_json,
                   created_at = CURRENT_TIMESTAMP`,
                [crypto.randomUUID(), sessionId, pageIndex, csvContent, JSON.stringify(provenanceCells)]
            );

            return { csvContent, provenanceCells, sanitizedWords };
        } catch (err) {
            console.error("requestTableFormat failed:", err);
            return null;
        } finally {
            setIsExtracting(false);
            await context.stopServer();
        }
    };

    return {
        ...context,
        requestTableFormat,
        streamingContent,
        isExtracting,
    };
};
