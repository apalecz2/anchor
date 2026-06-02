import { useContext } from "react";
import { LlamaChatContext } from "./LlamaChatContext";
import { readFileAsBase64, buildOcrExcerpt } from './promptUtils';
import type { FileAttachment } from '../extraction/types';

export const useLlamaChat = () => {
    const context = useContext(LlamaChatContext);

    if (!context) {
        throw new Error("useLlamaChat must be used within a LlamaChatProvider.");
    }

    // Build the specialized table formatter using the context's primitives
    const requestTableFormat = async (fileUrl: string, ocrText: string) => {
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
            'Return only a markdown table.',
            'No reasoning, no explanation, no code fences, no bullet points.',
            'Use the attached image as the primary reference and the OCR excerpt below as a guide.',
            '',
            'OCR excerpt:',
            normalizedText,
        ].join('\n');

        await context.sendMessage(prompt, attachment);
    };

    // Expose the new helper alongside the existing global context
    return {
        ...context,
        requestTableFormat
    };
};