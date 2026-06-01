import React, { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router';
import { getDb } from '../lib/db';
import DocumentViewer from '../components/DocumentViewer';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface BoundingBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface OcrWord {
    text: string;
    confidence: number;
    box_coords: BoundingBox;
}

export interface DocumentPageResult {
    image_path: string;
    natural_width: number;
    natural_height: number;
    words: OcrWord[];
    text: string;
}

export interface ExtractionResult {
    session_id: string;
    pages: DocumentPageResult[];
}

// Interface to keep the word linked to its index in the main array
interface LineWord {
    text: string;
    originalIndex: number;
}

// Returns LineWord[][] instead of string[]
const generateLinesFromWords = (words: OcrWord[]): LineWord[][] => {
    if (words.length === 0) return [];
    const lines: LineWord[][] = [];
    let currentLine: LineWord[] = [];
    let currentTop = words[0].box_coords.top;

    words.forEach((word, index) => {
        if (Math.abs(word.box_coords.top - currentTop) > 15) {
            lines.push(currentLine);
            currentLine = [{ text: word.text, originalIndex: index }];
            currentTop = word.box_coords.top;
        } else {
            currentLine.push({ text: word.text, originalIndex: index });
        }
    });

    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
};

export default function Session(): React.ReactElement {
    const { id } = useParams<{ id: string }>();

    const [leftWidth, setLeftWidth] = useState(50);
    const containerRef = useRef<HTMLDivElement>(null);
    const isDragging = useRef(false);

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [fileUrl, setFileUrl] = useState<string | null>(null);
    const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);

    // Dialog States
    const [pendingBox, setPendingBox] = useState<BoundingBox | null>(null);
    const [newWordText, setNewWordText] = useState("");
    const [editingWord, setEditingWord] = useState<{ index: number, text: string } | null>(null);

    // Central highlight state tracker
    const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);

    const hasProcessed = useRef(false);

    useEffect(() => {
        async function processDocument() {
            if (!id || hasProcessed.current) return;
            hasProcessed.current = true;

            try {
                setError(null);
                setIsLoading(true);
                const db = await getDb();

                // Check for cached OCR results in the database first
                const cachedPages = await db.select<{
                    image_path: string;
                    natural_width: number;
                    natural_height: number;
                    full_text: string;
                    words_json: string;
                }[]>(
                    'SELECT image_path, natural_width, natural_height, full_text, words_json FROM document_pages WHERE session_id = $1 ORDER BY page_index ASC',
                    [id]
                );

                if (cachedPages && cachedPages.length > 0) {
                    const restoredPages: DocumentPageResult[] = cachedPages.map(page => ({
                        image_path: page.image_path,
                        natural_width: page.natural_width,
                        natural_height: page.natural_height,
                        text: page.full_text,
                        words: JSON.parse(page.words_json)
                    }));
                    setExtractionResult({ session_id: id, pages: restoredPages });
                    setFileUrl(convertFileSrc(restoredPages[0].image_path));
                    return;
                }

                const dbResult = await db.select<{ file_path: string }[]>('SELECT file_path FROM files WHERE session_id = $1 LIMIT 1', [id]);
                if (!dbResult || dbResult.length === 0) throw new Error('No document attached to this session.');

                const rustResult = await invoke<ExtractionResult>('process_document', {
                    sessionId: id,
                    filePath: dbResult[0].file_path
                });

                for (let i = 0; i < rustResult.pages.length; i++) {
                    const page = rustResult.pages[i];
                    page.words = sortWords(page.words);

                    await db.execute(
                        `INSERT INTO document_pages (id, session_id, page_index, image_path, natural_width, natural_height, full_text, words_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [crypto.randomUUID(), id, i, page.image_path, page.natural_width, page.natural_height, page.text, JSON.stringify(page.words)]
                    );
                }

                setExtractionResult(rustResult);
                if (rustResult.pages.length > 0) setFileUrl(convertFileSrc(rustResult.pages[0].image_path));

            } catch (err) {
                console.error("Backend processing failed:", err);
                setError(err instanceof Error ? err.message : 'Failed to process document.');
                hasProcessed.current = false;
            } finally {
                setIsLoading(false);
            }
        }
        processDocument();
    }, [id]);

    const sortWords = (words: OcrWord[]) => {
        return [...words].sort((a, b) => {
            const verticalDiff = a.box_coords.top - b.box_coords.top;
            if (Math.abs(verticalDiff) > 15) return verticalDiff;
            return a.box_coords.left - b.box_coords.left;
        });
    };

    const updatePageStateAndDb = async (updatedPage: DocumentPageResult) => {
        if (!id || !extractionResult) return;

        // Convert the LineWord array back to a simple string for the DB text cache
        const lines = generateLinesFromWords(updatedPage.words);
        updatedPage.text = lines.map(line => line.map(w => w.text).join(' ')).join('\n');

        const newResult = { ...extractionResult };
        newResult.pages[0] = updatedPage;
        setExtractionResult(newResult);

        try {
            const db = await getDb();
            await db.execute(
                `UPDATE document_pages SET words_json = $1, full_text = $2 WHERE session_id = $3 AND page_index = $4`,
                [JSON.stringify(updatedPage.words), updatedPage.text, id, 0]
            );
        } catch (err) {
            console.error("Failed to update db:", err);
        }
    };

    const confirmSaveWord = async () => {
        if (!pendingBox || !newWordText.trim() || !extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[0]);
        updatedPage.words = sortWords([...updatedPage.words, {
            text: newWordText.trim(),
            confidence: 100,
            box_coords: pendingBox
        }]);

        setPendingBox(null);
        await updatePageStateAndDb(updatedPage);
    };

    const confirmEditWord = async () => {
        if (!editingWord || !extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[0]);

        if (editingWord.text.trim() === "") {
            updatedPage.words.splice(editingWord.index, 1);
        } else {
            updatedPage.words[editingWord.index].text = editingWord.text.trim();
            updatedPage.words[editingWord.index].confidence = 100;
        }

        setEditingWord(null);
        await updatePageStateAndDb(updatedPage);
    };

    const handleDeleteWord = async (index: number) => {
        if (!extractionResult) return;
        const updatedPage = structuredClone(extractionResult.pages[0]);
        updatedPage.words.splice(index, 1);
        await updatePageStateAndDb(updatedPage);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current || !containerRef.current) return;
            const containerRect = containerRef.current.getBoundingClientRect();
            const newWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;
            if (newWidth >= 20 && newWidth <= 80) setLeftWidth(newWidth);
        };
        const handleMouseUp = () => {
            if (isDragging.current) {
                isDragging.current = false;
                document.body.style.cursor = 'default';
            }
        };
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    const activePage = extractionResult?.pages[0];

    return (
        <main className="relative flex h-full w-full overflow-hidden bg-background">
            <div className="flex h-full w-full" ref={containerRef}>
                <div className="flex h-full flex-col bg-surface-container-lowest transition-[width] duration-0" style={{ width: `${leftWidth}%` }}>
                    <div className="border-b border-outline-variant p-4">
                        <h2 className="font-headline-sm text-primary">Source Document</h2>
                    </div>

                    <div className="flex flex-1 overflow-hidden relative">
                        {isLoading ? (
                            <div className="flex w-full items-center justify-center">Processing...</div>
                        ) : error ? (
                            <div className="flex w-full items-center justify-center text-error">{error}</div>
                        ) : fileUrl && activePage ? (
                            <DocumentViewer
                                fileUrl={fileUrl}
                                words={activePage.words}
                                onAddWord={(box) => { setPendingBox(box); setNewWordText(""); }}
                                onEditRequest={(index, currentText) => setEditingWord({ index, text: currentText })}
                                onDeleteRequest={(index) => handleDeleteWord(index)}
                                // Pass down the state hooks
                                highlightedIndex={highlightedIndex}
                                setHighlightedIndex={setHighlightedIndex}
                            />
                        ) : null}

                        {(pendingBox || editingWord) && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-50">
                                <div className="bg-surface-bright p-6 rounded-xl shadow-lg border border-outline-variant w-80">
                                    <h3 className="text-primary font-bold mb-4">
                                        {editingWord ? "Edit Word" : "Add Missing Text"}
                                    </h3>
                                    <input
                                        type="text"
                                        autoFocus
                                        value={editingWord ? editingWord.text : newWordText}
                                        onChange={e => editingWord ? setEditingWord({ ...editingWord, text: e.target.value }) : setNewWordText(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                editingWord ? confirmEditWord() : confirmSaveWord();
                                            }
                                        }}
                                        className="w-full p-2 mb-4 border border-outline rounded bg-surface text-on-surface"
                                        placeholder="Type text here..."
                                    />
                                    <div className="flex justify-end gap-2">
                                        <button onClick={() => { setPendingBox(null); setEditingWord(null); }} className="px-4 py-2 text-on-surface-variant hover:bg-surface-variant rounded">Cancel</button>
                                        <button onClick={() => editingWord ? confirmEditWord() : confirmSaveWord()} className="px-4 py-2 bg-primary text-on-primary rounded hover:bg-primary/90">Save Word</button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="group relative flex w-3 cursor-col-resize items-center justify-center" onMouseDown={() => isDragging.current = true}>
                    <div className="h-12 w-1 rounded-full bg-outline-variant group-hover:bg-primary" />
                </div>

                <div className="flex h-full flex-col p-6 transition-[width] duration-0" style={{ width: `${100 - leftWidth}%` }}>
                    <div className="mb-4">
                        <h1 className="font-headline-sm text-primary">Document Text</h1>
                    </div>

                    <div className="flex-1 overflow-auto rounded-2xl border border-outline-variant bg-surface-bright px-8 py-10 shadow-sm">
                        {isLoading ? (
                            <div className="flex h-full items-center justify-center">Awaiting extraction...</div>
                        ) : activePage && activePage.words ? (
                            <div className="space-y-2 font-body-md text-on-surface leading-relaxed select-none">
                                {/* Render text lines as interactive discrete span elements */}
                                {generateLinesFromWords(activePage.words).map((line, lineIndex) => (
                                    <p key={lineIndex} className="min-h-[1.5rem]">
                                        {line.map((wordObj, wordIdx) => (
                                            <React.Fragment key={`textword-${wordObj.originalIndex}`}>
                                                <span
                                                    className={`cursor-pointer px-0.5 py-px rounded transition-colors ${highlightedIndex === wordObj.originalIndex
                                                            ? 'bg-primary/20 text-primary font-bold'
                                                            : 'hover:bg-surface-variant'
                                                        }`}
                                                    onMouseEnter={() => setHighlightedIndex(wordObj.originalIndex)}
                                                    onMouseLeave={() => setHighlightedIndex(null)}
                                                    // Right click menu on the text triggers the same edit action
                                                    onContextMenu={(e) => {
                                                        e.preventDefault();
                                                        setEditingWord({ index: wordObj.originalIndex, text: wordObj.text });
                                                    }}
                                                >
                                                    {wordObj.text}
                                                </span>
                                                {/* Add spacing between words natively */}
                                                {wordIdx < line.length - 1 && " "}
                                            </React.Fragment>
                                        ))}
                                    </p>
                                ))}
                            </div>
                        ) : (
                            <div className="flex h-full items-center justify-center">No readable text found.</div>
                        )}
                    </div>
                </div>
            </div>
        </main>
    );
}