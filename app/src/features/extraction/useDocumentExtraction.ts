import { useState, useEffect, useRef } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getDb } from '../../lib/db';
import { ExtractionResult, DocumentPageResult } from './types';
import type { BoundingBox } from '../ocr/types';
import { sortWords, generateLinesFromWords } from '../../utils/ocrTransforms';

export function useDocumentExtraction(sessionId: string | undefined) {
    const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
    const [fileUrl, setFileUrl] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hasProcessed = useRef(false);

    useEffect(() => {
        async function processDocument() {
            if (!sessionId || hasProcessed.current) return;
            hasProcessed.current = true;

            try {
                setError(null);
                setIsLoading(true);
                const db = await getDb();

                const cachedPages = await db.select<any[]>(
                    'SELECT image_path, natural_width, natural_height, full_text, words_json FROM document_pages WHERE session_id = $1 ORDER BY page_index ASC',
                    [sessionId]
                );

                if (cachedPages && cachedPages.length > 0) {
                    const restoredPages: DocumentPageResult[] = cachedPages.map(page => ({
                        image_path: page.image_path,
                        natural_width: page.natural_width,
                        natural_height: page.natural_height,
                        text: page.full_text,
                        words: JSON.parse(page.words_json)
                    }));
                    setExtractionResult({ session_id: sessionId, pages: restoredPages });
                    setFileUrl(convertFileSrc(restoredPages[0].image_path));
                    return;
                }

                const dbResult = await db.select<{ file_path: string }[]>('SELECT file_path FROM files WHERE session_id = $1 LIMIT 1', [sessionId]);
                if (!dbResult || dbResult.length === 0) throw new Error('No document attached to this session.');

                const rustResult = await invoke<ExtractionResult>('process_document', {
                    sessionId,
                    filePath: dbResult[0].file_path
                });

                for (let i = 0; i < rustResult.pages.length; i++) {
                    const page = rustResult.pages[i];
                    page.words = sortWords(page.words);

                    await db.execute(
                        `INSERT INTO document_pages (id, session_id, page_index, image_path, natural_width, natural_height, full_text, words_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [crypto.randomUUID(), sessionId, i, page.image_path, page.natural_width, page.natural_height, page.text, JSON.stringify(page.words)]
                    );
                }

                setExtractionResult(rustResult);
                if (rustResult.pages.length > 0) setFileUrl(convertFileSrc(rustResult.pages[0].image_path));

            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to process document.');
                hasProcessed.current = false;
            } finally {
                setIsLoading(false);
            }
        }
        processDocument();
    }, [sessionId]);

    const updateDb = async (updatedPage: DocumentPageResult) => {
        if (!sessionId || !extractionResult) return;
        const lines = generateLinesFromWords(updatedPage.words);
        updatedPage.text = lines.map(line => line.map(w => w.text).join(' ')).join('\n');

        const newResult = { ...extractionResult };
        newResult.pages[0] = updatedPage;
        setExtractionResult(newResult);

        try {
            const db = await getDb();
            await db.execute(
                `UPDATE document_pages SET words_json = $1, full_text = $2 WHERE session_id = $3 AND page_index = $4`,
                [JSON.stringify(updatedPage.words), updatedPage.text, sessionId, 0]
            );
        } catch (err) {
            console.error("Failed to update db:", err);
        }
    };

    const addWord = async (text: string, box: BoundingBox) => {
        if (!extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[0]);
        updatedPage.words = sortWords([
            ...updatedPage.words,
            {
                text,
                confidence: 100,
                box_coords: box,
                pageNumber: 1,
                blockNumber: 1,
                paragraphNumber: 1,
                lineNumber: updatedPage.words.length + 1,
                wordNumber: updatedPage.words.length + 1,
            },
        ]);
        await updateDb(updatedPage);
    };

    const editWord = async (index: number, text: string) => {
        if (!extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[0]);
        if (text.trim() === "") {
            updatedPage.words.splice(index, 1);
        } else {
            updatedPage.words[index].text = text.trim();
            updatedPage.words[index].confidence = 100;
        }
        await updateDb(updatedPage);
    };

    const deleteWord = async (index: number) => {
        if (!extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[0]);
        updatedPage.words.splice(index, 1);
        await updateDb(updatedPage);
    };

    return { extractionResult, fileUrl, isLoading, error, addWord, editWord, deleteWord };
}