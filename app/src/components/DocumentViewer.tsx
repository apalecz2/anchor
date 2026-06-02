import React, { useState, useRef, useEffect } from 'react';
import type { OcrWord, BoundingBox } from '../features/ocr/types';

interface DocumentViewerProps {
    fileUrl: string;
    words: OcrWord[];
    onAddWord: (box: BoundingBox) => void;
    onEditRequest: (index: number, currentText: string) => void;
    onDeleteRequest: (index: number) => void;
    highlightedIndex: number | null;
    setHighlightedIndex: (index: number | null) => void;
    activeTool: 'draw' | 'pan';
    transform: { scale: number; x: number; y: number };
    setTransform: React.Dispatch<React.SetStateAction<{ scale: number; x: number; y: number }>>;
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
    setHighlightedIndex,
    activeTool,
    transform,
    setTransform
}: DocumentViewerProps) {
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
    const svgRef = useRef<SVGSVGElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Track active panning drag
    const [isDragging, setIsDragging] = useState(false);

    // Drawing State
    const [isDrawing, setIsDrawing] = useState(false);
    const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
    const [currentBox, setCurrentBox] = useState<BoundingBox | null>(null);

    // Context Menu State
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number, text: string } | null>(null);

    // --- Pan & Zoom Logic ---
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const zoomSensitivity = 0.002;
            const delta = -e.deltaY * zoomSensitivity;

            setTransform(prev => ({
                ...prev,
                scale: Math.min(Math.max(0.1, prev.scale * (1 + delta)), 10)
            }));
        };

        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, [setTransform]);

    useEffect(() => {
        const handleGlobalMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            setTransform(prev => ({
                ...prev,
                x: prev.x + e.movementX,
                y: prev.y + e.movementY
            }));
        };

        const handleGlobalMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            window.addEventListener('mousemove', handleGlobalMouseMove);
            window.addEventListener('mouseup', handleGlobalMouseUp);
        }

        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [isDragging, setTransform]);

    const handleContainerMouseDown = (e: React.MouseEvent) => {
        // Trigger pan on Middle-click OR Left-click if 'pan' tool is active
        if (e.button === 1 || (e.button === 0 && activeTool === 'pan')) {
            e.preventDefault();
            setIsDragging(true);
        }
    };

    // --- Drawing Logic ---
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
        // Prevent drawing if panning is active, target is a rect, right-click, or middle-click
        if (activeTool === 'pan' || (e.target as SVGElement).tagName === 'rect' || e.button === 2 || e.button === 1) return;
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
        <div 
            ref={containerRef}
            onMouseDown={handleContainerMouseDown}
            className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-surface-container-low p-4 ${isDragging ? 'cursor-grabbing' : activeTool === 'pan' ? 'cursor-grab' : ''}`}
        >
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

            <div 
                className="relative shadow-sm shadow-black/10"
                style={{
                    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                    transformOrigin: 'center',
                    transition: isDragging ? 'none' : 'transform 0.05s ease-out' 
                }}
            >
                <img
                    src={fileUrl}
                    alt="Document"
                    onLoad={handleImageLoad}
                    className="block max-h-[80vh] max-w-full object-contain pointer-events-none"
                />

                {naturalSize.width > 0 && (
                    <svg
                        ref={svgRef}
                        className={`absolute left-0 top-0 h-full w-full touch-none ${activeTool === 'pan' || isDragging ? 'pointer-events-none' : 'cursor-crosshair'}`}
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
                                    style={{
                                        fill: color,
                                        stroke: color,
                                    }}
                                    className={`pointer-events-auto cursor-pointer transition-all ${isHighlighted
                                            ? 'opacity-80 stroke-[4px]'
                                            : 'opacity-30 stroke-[2px] hover:opacity-60'
                                        }`}
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