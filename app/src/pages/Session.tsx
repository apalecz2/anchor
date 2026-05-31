import React, { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router';
import { getDb } from '../lib/db';
import DocumentViewer from '../components/DocumentViewer';
import { convertFileSrc } from '@tauri-apps/api/core';

export default function Session(): React.ReactElement {
    // Grab the dynamic :id parameter from the URL
    const { id } = useParams<{ id: string }>();

    // 1. State for the left panel width (percentage)
    const [leftWidth, setLeftWidth] = useState(50);
    const containerRef = useRef<HTMLDivElement>(null);

    const [fileUrl, setFileUrl] = useState<string | null>(null);
    const [isLoadingFile, setIsLoadingFile] = useState(true);
    const [fileError, setFileError] = useState<string | null>(null);

    // We use a ref for dragging state so we don't trigger re-renders just for the boolean
    const isDragging = useRef(false);

    // 2. Fetch the file path from the database
    useEffect(() => {
        let isMounted = true;

        async function fetchFileFromDb() {
            if (!id) return;
            
            try {
                setIsLoadingFile(true);
                const db = await getDb();
                
                // Query the files table for the file associated with this session
                const result = await db.select<{ file_path: string }[]>(
                    'SELECT file_path FROM files WHERE session_id = $1 LIMIT 1',
                    [id]
                );

                if (isMounted) {
                    if (result && result.length > 0) {
                        setFileUrl(convertFileSrc(result[0].file_path));
                    } else {
                        setFileError('No document attached to this session.');
                    }
                }
            } catch (error) {
                console.error("Failed to fetch file path:", error);
                if (isMounted) setFileError('Failed to load document.');
            } finally {
                if (isMounted) setIsLoadingFile(false);
            }
        }

        fetchFileFromDb();

        return () => {
            isMounted = false;
        };
    }, [id]);


    // 3. Global mouse event handlers for smooth dragging
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current || !containerRef.current) return;

            // Calculate the new percentage width based on mouse X position relative to the container
            const containerRect = containerRef.current.getBoundingClientRect();
            const newWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;

            // Clamp the width between 20% and 80% so a panel doesn't completely disappear
            if (newWidth >= 20 && newWidth <= 80) {
                setLeftWidth(newWidth);
            }
        };

        const handleMouseUp = () => {
            if (isDragging.current) {
                isDragging.current = false;
                // Reset the cursor across the whole app once dropping is done
                document.body.style.cursor = 'default';
            }
        };

        // Attach listeners to the document so dragging doesn't break if the user moves the mouse quickly off the divider
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    const handleMouseDown = () => {
        isDragging.current = true;
        // Lock the cursor to resize mode across the whole app while dragging
        document.body.style.cursor = 'col-resize';
    };

    return (
        <main className="relative flex h-full w-full overflow-hidden bg-background">

            {/* Master Flex Container */}
            <div className="flex h-full w-full" ref={containerRef}>

                {/* === LEFT SIDE: File Viewer === */}
                <div 
                    className="flex h-full flex-col bg-surface-container-lowest transition-[width] duration-0" 
                    style={{ width: `${leftWidth}%` }}
                >
                    <div className="border-b border-outline-variant p-4">
                        <h2 className="font-headline-sm text-primary">Source Document</h2>
                    </div>
                    
                    <div className="flex flex-1 overflow-hidden">
                        {isLoadingFile ? (
                            <div className="flex w-full items-center justify-center text-on-surface-variant">Loading file...</div>
                        ) : fileError ? (
                            <div className="flex w-full items-center justify-center text-error">{fileError}</div>
                        ) : fileUrl ? (
                            <DocumentViewer fileUrl={fileUrl} />
                        ) : null}
                    </div>
                </div>

                {/* === THE DRAGGABLE DIVIDER === */}
                <div
                    className="group relative flex w-3 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/10 active:bg-primary/20"
                    onMouseDown={handleMouseDown}
                >
                    {/* Visual indicator pill */}
                    <div className="h-12 w-1 rounded-full bg-outline-variant transition-colors group-hover:bg-primary group-active:bg-primary" />
                </div>

                {/* === RIGHT SIDE: Extraction Workspace === */}
                <div
                    className="flex h-full flex-col p-6 transition-[width] duration-0"
                    style={{ width: `${100 - leftWidth}%` }}
                >
                    <div className="mb-6 space-y-1">
                        <h1 className="font-display-sm text-primary">Extraction Output</h1>
                        <p className="font-body-sm text-on-surface-variant">
                            Session ID: <span className="font-mono text-xs">{id}</span>
                        </p>
                    </div>

                    <div className="flex-1 overflow-auto rounded-2xl border border-dashed border-outline-variant bg-surface-container-lowest p-6">

                        {/* Extracted JSON/Tables will go here */}
                        <p className="text-on-surface-variant">Structured data will appear here.</p>

                    </div>
                </div>

            </div>
        </main>
    );
}