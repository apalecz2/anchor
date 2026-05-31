import React, { useState } from 'react';
import type { OcrWord } from '../pages/Session';

interface DocumentViewerProps {
    fileUrl: string;
    words: OcrWord[];
}

const getConfidenceColor = (confidence: number) => {
    // Clamp the value between 0 and 100 to prevent invalid HSL values
    const clamped = Math.max(0, Math.min(100, confidence));

    // Map 0-100 to 0-120 (Hue: 0 = Red, 60 = Yellow, 120 = Green)
    const hue = (clamped / 100) * 120;

    return `hsl(${hue}, 80%, 45%)`;
};

export default function DocumentViewer({ fileUrl, words }: DocumentViewerProps) {
    // only need the original image dimensions to calibrate the SVG overlay
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });

    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        setNaturalSize({ width: naturalWidth, height: naturalHeight });
    };

    return (
        <div className="relative flex h-full w-full flex-col items-center justify-center overflow-auto bg-surface-container-low p-4">

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
                        {words.map((word, idx) => {
                            const color = getConfidenceColor(word.confidence);
                            return (
                                <rect
                                    key={`word-${idx}`}
                                    x={word.box_coords.left}
                                    y={word.box_coords.top}
                                    width={word.box_coords.width}
                                    height={word.box_coords.height}
                                    // 3. Apply the dynamic color via inline styles
                                    style={{
                                        fill: color,
                                        stroke: color,
                                    }}
                                    // 4. Swap Tailwind color classes for opacity to handle the hover state cleanly
                                    className="pointer-events-auto cursor-pointer stroke-[2px] opacity-30 transition-opacity hover:opacity-80"
                                    onClick={() => console.log(`Word: ${word.text} | Confidence: ${word.confidence}`)}
                                >
                                    {/* Updated the title to also show the user the exact confidence score on hover */}
                                    <title>{`${word.text} (Confidence: ${word.confidence.toFixed(1)}%)`}</title>
                                </rect>
                            );
                        })}
                    </svg>
                )}
            </div>
        </div>
    );
}