import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { OcrWord, BoundingBox } from '../features/ocr/types';

export interface DocumentViewerHandle {
    fitToScreen: () => void;
    zoomTo: (scale: number) => void;
}

// Default lower zoom bound for panes large enough to hold the fitted image. When
// the pane is smaller than that, the bound drops to the fit scale so the image can
// always be shrunk to fit (see updateZoomBounds).
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const FIT_INSET = 16; // breathing room around the fitted image, in px

interface DocumentViewerProps {
    fileUrl: string;
    words: OcrWord[];
    onAddWord: (box: BoundingBox) => void;
    onEditRequest: (id: string, currentText: string) => void;
    onDeleteRequest: (id: string) => void;
    highlightedWordId: string | null;
    setHighlightedWordId: (id: string | null) => void;
    onWordClick?: (wordId: string) => void;
    activeTool: 'draw' | 'pan';
    transform: { scale: number; x: number; y: number };
    setTransform: React.Dispatch<React.SetStateAction<{ scale: number; x: number; y: number }>>;
    provenanceHighlightBox?: BoundingBox | null;
    onMinScaleChange?: (minScale: number) => void;
    /** Fired when the source image fails to load (e.g. the file was moved/deleted). */
    onLoadError?: () => void;
}

const getConfidenceColor = (confidence: number) => {
    const clamped = Math.max(0, Math.min(100, confidence));
    const hue = (clamped / 100) * 120;
    return `hsl(${hue}, 80%, 45%)`;
};

// Estimate whether the document image is predominantly dark by averaging the
// perceived luminance of a downscaled copy. Used to pick a highlight color that
// contrasts with the image itself rather than the app's light/dark theme — a
// dark scan needs a light highlight, a light scan a dark one. Returns false if
// the canvas can't be read (e.g. a tainted cross-origin image).
function estimateImageDarkness(img: HTMLImageElement): boolean {
    try {
        const w = 32;
        const h = 32;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
            total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        return total / (data.length / 4) < 128;
    } catch {
        return false;
    }
}

const DocumentViewer = forwardRef<DocumentViewerHandle, DocumentViewerProps>(function DocumentViewer({
    fileUrl,
    words,
    onAddWord,
    onEditRequest,
    onDeleteRequest,
    highlightedWordId,
    setHighlightedWordId,
    onWordClick,
    activeTool,
    transform,
    setTransform,
    provenanceHighlightBox,
    onMinScaleChange,
    onLoadError,
}: DocumentViewerProps, ref) {
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
    // Whether the loaded document is dark overall, so highlights contrast with it.
    const [isImageDark, setIsImageDark] = useState(false);
    const svgRef = useRef<SVGSVGElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);

    // Current lower zoom bound. Dynamic: never above MIN_SCALE, but lowered to the
    // fit scale (and never above the current scale) so the image can always be
    // shrunk to fit the pane and the slider thumb stays truthful after a resize.
    const minScaleRef = useRef(MIN_SCALE);
    // Latest scale, read inside stable callbacks without making them stale.
    const scaleRef = useRef(transform.scale);
    scaleRef.current = transform.scale;

    // Track active panning drag
    const [isDragging, setIsDragging] = useState(false);

    // Whether the initial fit-to-screen has been computed and committed for the
    // current image. Until then the image is kept hidden (and un-transitioned) so
    // the user never sees it pop in at scale 1 and then animate down to the fit
    // scale — they only ever see it already fitted.
    const [isReady, setIsReady] = useState(false);

    // Drawing State
    const [isDrawing, setIsDrawing] = useState(false);
    const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
    const [currentBox, setCurrentBox] = useState<BoundingBox | null>(null);

    // Context Menu State
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, id: string, text: string } | null>(null);

    // --- Pan & Zoom Logic ---
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const zoomSensitivity = 0.002;
            const delta = -e.deltaY * zoomSensitivity;

            // Focal point of the zoom: cursor position relative to the container's
            // top-left (the transform-origin), so the point under the cursor stays put.
            const rect = container.getBoundingClientRect();
            const focalX = e.clientX - rect.left;
            const focalY = e.clientY - rect.top;

            setTransform(prev => {
                const newScale = Math.min(MAX_SCALE, Math.max(minScaleRef.current, prev.scale * (1 + delta)));
                const ratio = newScale / prev.scale;
                return {
                    scale: newScale,
                    x: focalX - ratio * (focalX - prev.x),
                    y: focalY - ratio * (focalY - prev.y),
                };
            });
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

    // The scale that fits the whole image within the container (with margins), or
    // null if not measurable yet.
    const getFitScale = useCallback((): number | null => {
        const container = containerRef.current;
        const img = imgRef.current;
        if (!container || !img || !img.offsetWidth || !img.offsetHeight) return null;
        return Math.min(
            (container.clientWidth - FIT_INSET * 2) / img.offsetWidth,
            (container.clientHeight - FIT_INSET * 2) / img.offsetHeight,
        );
    }, []);

    // Recompute the lower zoom bound for the current pane size and report it up so
    // the slider's range tracks it. Only touches the bound — never the transform —
    // so resizing the pane does not move or rescale the image.
    const updateZoomBounds = useCallback(() => {
        const fit = getFitScale();
        if (fit === null) return;
        const newMin = Math.min(MIN_SCALE, fit, scaleRef.current);
        if (newMin !== minScaleRef.current) {
            minScaleRef.current = newMin;
            onMinScaleChange?.(newMin);
        }
    }, [getFitScale, onMinScaleChange]);

    // Scale the image so it fits entirely within the container, then center it.
    // With a top-left transform-origin, centering means computing the corner offset
    // explicitly. The fit scale is allowed below MIN_SCALE so a small pane truly fits.
    const fitToScreen = useCallback(() => {
        const container = containerRef.current;
        const img = imgRef.current;
        const fit = getFitScale();
        if (!container || !img || fit === null) return;

        const cw = container.clientWidth;
        const ch = container.clientHeight;
        const scale = Math.min(MAX_SCALE, fit);
        minScaleRef.current = Math.min(MIN_SCALE, scale);
        onMinScaleChange?.(minScaleRef.current);
        setTransform({
            scale,
            x: (cw - img.offsetWidth * scale) / 2,
            y: (ch - img.offsetHeight * scale) / 2,
        });
    }, [getFitScale, onMinScaleChange, setTransform]);

    // Zoom to a target scale about the center of the visible area (used by the
    // slider and zoom buttons), keeping that center point fixed.
    const zoomTo = useCallback((target: number) => {
        const container = containerRef.current;
        if (!container) return;
        const focalX = container.clientWidth / 2;
        const focalY = container.clientHeight / 2;
        setTransform(prev => {
            const newScale = Math.min(MAX_SCALE, Math.max(minScaleRef.current, target));
            const ratio = newScale / prev.scale;
            return {
                scale: newScale,
                x: focalX - ratio * (focalX - prev.x),
                y: focalY - ratio * (focalY - prev.y),
            };
        });
    }, [setTransform]);

    useImperativeHandle(ref, () => ({ fitToScreen, zoomTo }), [fitToScreen, zoomTo]);

    // A new image (e.g. switching pages) must be re-fitted, so hide it again until
    // its onLoad recomputes the fit. Resetting here — rather than in onLoad — avoids
    // briefly showing the stale, already-fitted previous image under the new src.
    useEffect(() => {
        setIsReady(false);
    }, [fileUrl]);

    // Keep the zoom range in sync with the pane size as the split divider moves.
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const ro = new ResizeObserver(() => updateZoomBounds());
        ro.observe(container);
        return () => ro.disconnect();
    }, [updateZoomBounds]);

    // --- Drawing Logic ---
    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        setNaturalSize({ width: naturalWidth, height: naturalHeight });
        setIsImageDark(estimateImageDarkness(e.currentTarget));
        fitToScreen();
        // Reveal only after the fit transform has been committed and painted, so
        // the first frame the user sees is already at the fit scale. Flipping
        // isReady in a rAF (rather than synchronously here) guarantees the transform
        // doesn't change in the same render that turns transitions back on, so the
        // reveal is a clean fade — never an animated zoom from scale 1.
        requestAnimationFrame(() => setIsReady(true));
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
                            onClick={() => { onEditRequest(contextMenu.id, contextMenu.text); setContextMenu(null); }}
                        >
                            Edit Text
                        </button>
                        <button
                            className="px-4 py-2 text-left hover:bg-error/10 text-error text-sm transition-colors"
                            onClick={() => { onDeleteRequest(contextMenu.id); setContextMenu(null); }}
                        >
                            Delete Word
                        </button>
                    </div>
                </>
            )}

            <div
                className="absolute left-0 top-0 shadow-sm shadow-black/10"
                style={{
                    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                    transformOrigin: '0 0',
                    opacity: isReady ? 1 : 0,
                    // No transition until the initial fit is in place, so applying that
                    // fit can't animate; afterwards, fade in and keep the smooth zoom.
                    transition: isReady
                        ? (isDragging ? 'none' : 'transform 0.05s ease-out, opacity 0.15s ease-out')
                        : 'none',
                }}
            >
                <img
                    ref={imgRef}
                    src={fileUrl}
                    alt="Document"
                    onLoad={handleImageLoad}
                    onError={onLoadError}
                    className="block max-h-[80vh] w-auto max-w-none pointer-events-none select-none"
                />

                {naturalSize.width > 0 && (() => {
                // Highlight color contrasts with the document, not the app theme:
                // white over dark scans, black over light scans.
                const highlightFill = isImageDark ? 'fill-white/25' : 'fill-black/20';
                const highlightStroke = isImageDark ? 'stroke-white' : 'stroke-black';
                return (
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
                        {words.map((word) => {
                            const color = getConfidenceColor(word.confidence);
                            const isHighlighted = highlightedWordId === word.id;

                            return (
                                <rect
                                    key={`word-${word.id}`}
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
                                    onMouseEnter={() => setHighlightedWordId(word.id)}
                                    onMouseLeave={() => setHighlightedWordId(null)}
                                    onClick={(e) => { e.stopPropagation(); onWordClick?.(word.id); }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setContextMenu({ x: e.clientX, y: e.clientY, id: word.id, text: word.text });
                                    }}
                                >
                                    <title>{`${word.text} (Confidence: ${word.confidence.toFixed(1)}%)`}</title>
                                </rect>
                            );
                        })}

                        {provenanceHighlightBox && (
                            <rect
                                x={provenanceHighlightBox.left - 2}
                                y={provenanceHighlightBox.top - 2}
                                width={provenanceHighlightBox.width + 4}
                                height={provenanceHighlightBox.height + 4}
                                className={`${highlightFill} ${highlightStroke} stroke-[2px]`}
                                style={{ pointerEvents: 'none', vectorEffect: 'non-scaling-stroke' }}
                            />
                        )}

                        {isDrawing && currentBox && (
                            <rect
                                x={currentBox.left}
                                y={currentBox.top}
                                width={currentBox.width}
                                height={currentBox.height}
                                className={`${highlightFill} ${highlightStroke} stroke-[3px]`}
                            />
                        )}
                    </svg>
                );
                })()}
            </div>
        </div>
    );
});

export default DocumentViewer;