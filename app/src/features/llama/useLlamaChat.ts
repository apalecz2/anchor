import { useContext } from "react";
import { LlamaChatContext } from "./LlamaChatContext";
import { readFileAsBase64, buildOcrExcerpt } from './promptUtils';
import { getDb } from '../../lib/db';
import type { FileAttachment } from '../extraction/types';

export const useLlamaChat = () => {
    const context = useContext(LlamaChatContext);

    if (!context) {
        throw new Error("useLlamaChat must be used within a LlamaChatProvider.");
    }

    // Build the specialized table formatter using the context's primitives
    const requestTableFormat = async (fileUrl: string, ocrText: string, sessionId: string, pageIndex: number) => {
        if (!context.isServerReady) {
            await context.startServer();
        }

        const response = await fetch(fileUrl);
        const blob = await response.blob();
        const file = new File([blob], "source_document.png", { type: blob.type });

        const attachment: FileAttachment = {
            name: file.name,
            type: file.type || 'image/png',
            data: await readFileAsBase64(file),
        };

        const normalizedText = buildOcrExcerpt(ocrText, 80, 5000);
        const prompt = [
            'Return only CSV (comma-separated values).',
            'First row must be the column headers.',
            'No reasoning, no explanation, no code fences, no markdown.',
            'Quote any field that contains a comma.',
            'If two adjacent values belong to the same visual column (e.g. a department code and a course number), output them as one field joined by a space.',
            'Use the attached image as the primary reference and the OCR excerpt below as a guide.',
            '',
            'OCR excerpt:',
            normalizedText,
        ].join('\n');

        const csvContent = await context.sendMessage(prompt, attachment);
        await context.stopServer();

        if (csvContent) {
            try {
                const db = await getDb();
                await db.execute(
                    `INSERT INTO csv_outputs (id, session_id, page_index, csv_content)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT(session_id, page_index) DO UPDATE SET csv_content = excluded.csv_content, created_at = CURRENT_TIMESTAMP`,
                    [crypto.randomUUID(), sessionId, pageIndex, csvContent]
                );
            } catch (err) {
                console.error("Failed to save CSV output:", err);
            }
        }
    };

    // Expose the new helper alongside the existing global context
    return {
        ...context,
        requestTableFormat
    };
};