import React, { useState, useRef } from 'react';
import type { OcrWord, BoundingBox } from '../pages/Session';

interface DocumentViewerProps {
    fileUrl: string;
    words: OcrWord[];
    onAddWord: (box: BoundingBox) => void;
    onEditRequest: (index: number, currentText: string) => void;
    onDeleteRequest: (index: number) => void;
    // Sync states for bi-directional highlighting
    highlightedIndex: number | null;
    setHighlightedIndex: (index: number | null) => void;
}

const getConfidenceColor = (confidence: number) => {
    const clamped = Math.max(0, Math.min(100, confidence));
    const hue = (clamped / 100) * 120;
    return `hsl(${hue}, 80%, 45%)`;
};

export default function DocumentViewer({
    fileUrl,
    words,
    onAddWord,
    onEditRequest,
    onDeleteRequest,
    highlightedIndex,
    setHighlightedIndex
}: DocumentViewerProps) {
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
    const svgRef = useRef<SVGSVGElement>(null);

    // Drawing State
    const [isDrawing, setIsDrawing] = useState(false);
    const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
    const [currentBox, setCurrentBox] = useState<BoundingBox | null>(null);

    // Context Menu State
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number, text: string } | null>(null);

    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        setNaturalSize({ width: naturalWidth, height: naturalHeight });
    };

    const getSvgPoint = (e: React.MouseEvent | MouseEvent) => {
        if (!svgRef.current) return null;
        const pt = svgRef.current.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const ctm = svgRef.current.getScreenCTM();
        if (!ctm) return null;
        return pt.matrixTransform(ctm.inverse());
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if ((e.target as SVGElement).tagName === 'rect' || e.button === 2) return;
        const pt = getSvgPoint(e);
        if (!pt) return;

        setIsDrawing(true);
        setStartPos({ x: pt.x, y: pt.y });
        setCurrentBox({ left: pt.x, top: pt.y, width: 0, height: 0 });
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDrawing || !startPos) return;
        const pt = getSvgPoint(e);
        if (!pt) return;

        setCurrentBox({
            left: Math.min(startPos.x, pt.x),
            top: Math.min(startPos.y, pt.y),
            width: Math.abs(pt.x - startPos.x),
            height: Math.abs(pt.y - startPos.y),
        });
    };

    const handleMouseUp = () => {
        if (isDrawing && currentBox && currentBox.width > 5 && currentBox.height > 5) {
            onAddWord({
                left: Math.round(currentBox.left),
                top: Math.round(currentBox.top),
                width: Math.round(currentBox.width),
                height: Math.round(currentBox.height)
            });
        }
        setIsDrawing(false);
        setStartPos(null);
        setCurrentBox(null);
    };

    return (
        <div className="relative flex h-full w-full flex-col items-center justify-center overflow-auto bg-surface-container-low p-4">

            {contextMenu && (
                <>
                    <div
                        className="fixed inset-0 z-40"
                        onClick={() => setContextMenu(null)}
                        onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
                    />
                    <div
                        className="fixed z-50 bg-surface-bright border border-outline-variant rounded-md shadow-xl py-1 flex flex-col min-w-30 overflow-hidden"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <button
                            className="px-4 py-2 text-left hover:bg-surface-variant text-on-surface text-sm transition-colors"
                            onClick={() => { onEditRequest(contextMenu.index, contextMenu.text); setContextMenu(null); }}
                        >
                            Edit Text
                        </button>
                        <button
                            className="px-4 py-2 text-left hover:bg-error/10 text-error text-sm transition-colors"
                            onClick={() => { onDeleteRequest(contextMenu.index); setContextMenu(null); }}
                        >
                            Delete Word
                        </button>
                    </div>
                </>
            )}

            <div className="relative shadow-sm shadow-black/10">
                <img
                    src={fileUrl}
                    alt="Document"
                    onLoad={handleImageLoad}
                    className="block max-h-[80vh] max-w-full object-contain pointer-events-none"
                />

                {naturalSize.width > 0 && (
                    <svg
                        ref={svgRef}
                        className="absolute left-0 top-0 h-full w-full cursor-crosshair touch-none"
                        viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`}
                        preserveAspectRatio="xMidYMid meet"
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp}
                        onContextMenu={(e) => e.preventDefault()}
                    >
                        {words.map((word, idx) => {
                            const color = getConfidenceColor(word.confidence);
                            const isHighlighted = highlightedIndex === idx;

                            return (
                                <rect
                                    key={`word-${idx}`}
                                    x={word.box_coords.left}
                                    y={word.box_coords.top}
                                    width={word.box_coords.width}
                                    height={word.box_coords.height}
                                    // Dynamically adjust styling based on the active index
                                    style={{
                                        fill: color,
                                        stroke: color,
                                    }}
                                    className={`pointer-events-auto cursor-pointer transition-all ${isHighlighted
                                            ? 'opacity-80 stroke-[4px]'
                                            : 'opacity-30 stroke-[2px] hover:opacity-60'
                                        }`}
                                    // Trigger global highlight state on hover
                                    onMouseEnter={() => setHighlightedIndex(idx)}
                                    onMouseLeave={() => setHighlightedIndex(null)}
                                    onClick={(e) => e.stopPropagation()}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setContextMenu({ x: e.clientX, y: e.clientY, index: idx, text: word.text });
                                    }}
                                >
                                    <title>{`${word.text} (Confidence: ${word.confidence.toFixed(1)}%)`}</title>
                                </rect>
                            );
                        })}

                        {isDrawing && currentBox && (
                            <rect
                                x={currentBox.left}
                                y={currentBox.top}
                                width={currentBox.width}
                                height={currentBox.height}
                                className="fill-primary/20 stroke-primary stroke-[3px]"
                            />
                        )}
                    </svg>
                )}
            </div>
        </div>
    );
}