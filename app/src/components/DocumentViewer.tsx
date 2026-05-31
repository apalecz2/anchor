import React, { useState, useEffect } from 'react';
import { recognizeOcrImage } from '../features/ocr/ocrClient';
import type { OcrWord } from '../features/ocr/types';

interface DocumentViewerProps {
    fileUrl: string; // Object URL or Asset URL
}

export default function DocumentViewer({ fileUrl }: DocumentViewerProps) {
    const [words, setWords] = useState<OcrWord[]>([]);
    const [status, setStatus] = useState<string>('idle');
    const [progress, setProgress] = useState<number>(0);
    
    // We need the original image dimensions to calibrate the SVG overlay
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        if (!fileUrl) return;

        let isMounted = true;

        const runOcr = async () => {
            try {
                const result = await recognizeOcrImage(fileUrl, (prog) => {
                    if (isMounted) {
                        setStatus(prog.status || 'processing');
                        setProgress(prog.progress);
                    }
                });
                
                if (isMounted) {
                    setWords(result.words);
                    setStatus('complete');
                }
            } catch (error) {
                console.error("OCR Failed:", error);
                if (isMounted) setStatus('error');
            }
        };

        runOcr();

        return () => { isMounted = false; };
    }, [fileUrl]);

    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        setNaturalSize({ width: naturalWidth, height: naturalHeight });
    };

    return (
        <div className="relative flex h-full w-full flex-col items-center justify-center overflow-auto bg-surface-container-low p-4">
            
            {/* Status Indicator */}
            {status !== 'complete' && status !== 'idle' && (
                <div className="absolute top-4 z-20 rounded-full bg-surface-variant px-4 py-2 text-sm text-on-surface shadow-md">
                    {status === 'error' ? 'OCR Failed' : `Processing: ${Math.round(progress * 100)}%`}
                </div>
            )}

            {/* The Image & Overlay Container */}
            <div className="relative shadow-sm shadow-black/10">
                
                {/* 1. The Base Image */}
                <img 
                    src={fileUrl} 
                    alt="Document" 
                    onLoad={handleImageLoad}
                    className="block max-h-[80vh] max-w-full object-contain"
                />

                {/* 2. The SVG Overlay */}
                {naturalSize.width > 0 && (
                    <svg 
                        className="pointer-events-none absolute left-0 top-0 h-full w-full"
                        // This maps the SVG coordinate system to the image's original pixels
                        viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`}
                        preserveAspectRatio="xMidYMid meet"
                    >
                        {words.map((word, idx) => (
                            <rect 
                                key={`${word.blockNumber}-${word.lineNumber}-${idx}`}
                                x={word.box.left}
                                y={word.box.top}
                                width={word.box.width}
                                height={word.box.height}
                                className="pointer-events-auto cursor-pointer fill-primary/10 stroke-primary/60 stroke-[2px] transition-colors hover:fill-primary/30"
                                onClick={() => console.log("Clicked word:", word.text)}
                            >
                                <title>{word.text}</title>
                            </rect>
                        ))}
                    </svg>
                )}
            </div>
        </div>
    );
}