import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { OcrWord, BoundingBox } from '../features/ocr/types';
import { useTheme } from '../hooks/useTheme';
import { clampZoom, maxZoomFor } from './documentZoom';

export interface DocumentViewerHandle {
    fitToScreen: () => void;
    /** Center the given box in the viewport, zooming in (never out) just enough
     *  to make it comfortably visible. Used to bring a newly-selected cell's
     *  source region into view when it's off-screen or too small to read. */
    zoomToBox: (box: BoundingBox) => void;
}

// Zoom is relative to the fitted image, not to its natural pixels: 1 means the
// page exactly fits the visible pane (with FIT_INSET breathing room), 0.5 means
// half that size. The ceiling is *derived* from the fit rather than fixed, so
// 1:1 with the source pixels is always reachable — see documentZoom.ts, which
// owns all of this arithmetic.
const FIT_INSET = 16; // breathing room around the fitted image, in px

// Word-level confidence at/above this is treated as "high" and, under the
// 'issues' overlay mode, dimmed to invisible-until-hovered. Mirrors the
// ocrNorm >= 0.85 "high" threshold in confidence.ts's cellTrust, so the same
// number means "trustworthy" everywhere in the app.
const OVERLAY_HIGH_CONFIDENCE = 85;

// Target fraction of the shorter container dimension a zoomed-to box should
// occupy, so it's clearly readable but keeps surrounding context visible.
const ZOOM_TO_BOX_TARGET_FRACTION = 0.35;

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
    /** Zoom relative to the fitted size (1 = fits the pane); see documentZoom.ts. */
    zoom: number;
    /** Reports zoom changes made inside the viewer (wheel, fit, zoomToBox). */
    onZoomChange: (zoom: number) => void;
    /** Reports the natural-pixels-to-pane scale of the fitted view, or null
     *  before both the image and the pane have been measured. Only the viewer
     *  knows it, and the toolbar needs it for two things it cannot otherwise
     *  derive: the zoom ceiling (`maxZoomFor`) and the true-size readout. */
    onFitScaleChange?: (fitScale: number | null) => void;
    provenanceHighlightBox?: BoundingBox | null;
    /** How closely `provenanceHighlightBox` bounds the cell's actual source.
     *  `'exact'` means the box is the union of the words (or cells) the value came
     *  from; `'coarse'` means the grounding source only located the *region* it sits
     *  in, so the box is a neighbourhood, not the text. Drawn differently — a solid
     *  outline that is quietly wrong about where a value is would be worse than no
     *  highlight at all. */
    highlightPrecision?: 'exact' | 'coarse';
    /** Fired when the source image fails to load (e.g. the file was moved/deleted). */
    onLoadError?: () => void;
    /** 'all' shows every OCR region at its normal ambient opacity; 'issues' dims
     *  high-confidence boxes to invisible-until-hovered so only the uncertain
     *  ones stand out; 'none' hides the overlay entirely. */
    overlayMode?: 'all' | 'issues' | 'none';
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
    zoom,
    onZoomChange,
    onFitScaleChange,
    provenanceHighlightBox,
    highlightPrecision = 'exact',
    onLoadError,
    overlayMode = 'all',
}: DocumentViewerProps, ref) {
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
    // Live pane size, tracked by a ResizeObserver. Part of the view model: the
    // on-screen transform is re-derived from it, which is what keeps the image
    // correctly sized and positioned through any window/divider resize.
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    // The image-space point (in natural-pixel coordinates) pinned to the middle
    // of the pane. Panning moves it; zooming (about a focal point) re-derives it.
    // Storing the view as (zoom, center) rather than a raw pixel transform means
    // a resize needs no correction at all — the derived transform below simply
    // re-centers the same content at the same relative size.
    const [center, setCenter] = useState({ x: 0, y: 0 });
    // Whether the loaded document is dark overall, so highlights contrast with it.
    const [isImageDark, setIsImageDark] = useState(false);
    // The pane's backdrop follows the app theme, so the page's own shadow has to
    // know it to keep the image separated from it (see imageShadow below).
    const [theme] = useTheme();
    const svgRef = useRef<SVGSVGElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);

    // Track active panning drag
    const [isDragging, setIsDragging] = useState(false);

    // Whether the image is fully measured and fitted for the current src. Until
    // then it's kept hidden (and un-transitioned) so the user never sees it pop
    // in at the wrong scale — the first visible frame is already fitted.
    const [isReady, setIsReady] = useState(false);

    // Drawing State
    const [isDrawing, setIsDrawing] = useState(false);
    const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
    const [currentBox, setCurrentBox] = useState<BoundingBox | null>(null);

    // Context Menu State
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, id: string, text: string } | null>(null);

    // --- Derived view transform ---
    // The scale that makes the whole image fit the pane (null until both the
    // image and the pane have been measured). zoom multiplies this, so zoom 0.5
    // is always exactly half the fitted size for the *current* pane.
    const fitScale =
        naturalSize.width > 0 &&
        containerSize.width > FIT_INSET * 2 &&
        containerSize.height > FIT_INSET * 2
            ? Math.min(
                (containerSize.width - FIT_INSET * 2) / naturalSize.width,
                (containerSize.height - FIT_INSET * 2) / naturalSize.height,
            )
            : null;
    const maxZoom = maxZoomFor(fitScale);
    const scale = fitScale !== null ? clampZoom(zoom, maxZoom) * fitScale : 1;
    const offsetX = containerSize.width / 2 - center.x * scale;
    const offsetY = containerSize.height / 2 - center.y * scale;

    // A scan whose overall tone matches the backdrop — a light page in light mode,
    // a dark one in dark mode — meets the surface with no visible edge, so give it
    // one: a soft halo in the opposite tone. When image and backdrop already
    // contrast, the usual hairline shadow is enough. Reuses the same darkness
    // estimate that picks the highlight color.
    // Lengths are divided by `scale` because the shadow sits on the transformed
    // wrapper and is scaled along with it — at the fitted zoom of a large page
    // (scale well under 1) a fixed halo would shrink away to nothing.
    const shadowPx = (v: number) => `${v / scale}px`;
    const isThemeDark = theme === 'dark';
    const imageShadow =
        isImageDark !== isThemeDark
            ? `0 ${shadowPx(1)} ${shadowPx(2)} rgb(0 0 0 / 0.1)`
            : isThemeDark
                ? `0 0 0 ${shadowPx(1)} rgb(255 255 255 / 0.25), 0 0 ${shadowPx(28)} ${shadowPx(4)} rgb(255 255 255 / 0.13)`
                : `0 0 0 ${shadowPx(1)} rgb(0 0 0 / 0.12), 0 ${shadowPx(2)} ${shadowPx(28)} ${shadowPx(4)} rgb(0 0 0 / 0.25)`;

    // Snapshot of the current view, read inside stable event handlers (wheel,
    // drag, imperative calls) without making them stale or re-attached.
    const viewRef = useRef({ zoom, fitScale, maxZoom, scale, cw: 0, ch: 0, center });
    viewRef.current = { zoom, fitScale, maxZoom, scale, cw: containerSize.width, ch: containerSize.height, center };
    const onZoomChangeRef = useRef(onZoomChange);
    onZoomChangeRef.current = onZoomChange;
    const onFitScaleChangeRef = useRef(onFitScaleChange);
    onFitScaleChangeRef.current = onFitScaleChange;

    // Publish the fit scale, and pull the zoom back under the ceiling it implies.
    // The ceiling moves whenever the fit does (split-divider drag, window resize,
    // a new page of a different size), and a zoom left above it would render
    // clamped while the toolbar still showed — and stepped from — the stale
    // value. The render clamps regardless, so this only reconciles the state.
    // Both callbacks are read through refs so an inline arrow from the parent
    // can't turn this into a per-render effect.
    useEffect(() => {
        onFitScaleChangeRef.current?.(fitScale);
        if (fitScale !== null && zoom > maxZoomFor(fitScale)) {
            onZoomChangeRef.current(maxZoomFor(fitScale));
        }
    }, [fitScale, zoom]);

    // --- Pan & Zoom interactions ---
    // Keep the pane size in sync (split divider, window resize). Only state is
    // updated here; the transform correction falls out of the derivation above.
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const measure = () => setContainerSize({ width: container.clientWidth, height: container.clientHeight });
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(container);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const { zoom, fitScale, maxZoom, scale, cw, ch, center } = viewRef.current;
            if (fitScale === null) return;
            const newZoom = clampZoom(zoom * Math.exp(-e.deltaY * 0.002), maxZoom);
            if (newZoom === zoom) return;
            const newScale = newZoom * fitScale;

            // Keep the image point under the cursor stationary: express the
            // cursor relative to the pane center, find the image point there,
            // and choose the new center so that point maps back to the cursor.
            const rect = container.getBoundingClientRect();
            const fx = e.clientX - rect.left - cw / 2;
            const fy = e.clientY - rect.top - ch / 2;
            setCenter({
                x: center.x + fx / scale - fx / newScale,
                y: center.y + fy / scale - fy / newScale,
            });
            onZoomChangeRef.current(newZoom);
        };

        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, []);

    useEffect(() => {
        if (!isDragging) return;

        const handleGlobalMouseMove = (e: MouseEvent) => {
            const { scale } = viewRef.current;
            setCenter(prev => ({
                x: prev.x - e.movementX / scale,
                y: prev.y - e.movementY / scale,
            }));
        };
        const handleGlobalMouseUp = () => setIsDragging(false);

        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [isDragging]);

    const handleContainerMouseDown = (e: React.MouseEvent) => {
        // Trigger pan on Middle-click OR Left-click if 'pan' tool is active
        if (e.button === 1 || (e.button === 0 && activeTool === 'pan')) {
            e.preventDefault();
            setIsDragging(true);
        }
    };

    // Reset to the fitted view: whole image visible, centered, zoom 1.
    const fitToScreen = useCallback(() => {
        setCenter({ x: naturalSize.width / 2, y: naturalSize.height / 2 });
        onZoomChangeRef.current(1);
    }, [naturalSize]);

    // Center `box` in the viewport, zooming in only as much as needed to make it
    // readable — never zooming out, so a user who's already zoomed in past that
    // point just gets re-centered instead of yanked back out.
    const zoomToBox = useCallback((box: BoundingBox) => {
        const { zoom, fitScale, maxZoom, cw, ch } = viewRef.current;
        if (fitScale === null || box.width <= 0 || box.height <= 0) return;
        const desiredScale = Math.min(
            (cw * ZOOM_TO_BOX_TARGET_FRACTION) / box.width,
            (ch * ZOOM_TO_BOX_TARGET_FRACTION) / box.height,
        );
        setCenter({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
        onZoomChangeRef.current(clampZoom(Math.max(zoom, desiredScale / fitScale), maxZoom));
    }, []);

    useImperativeHandle(ref, () => ({ fitToScreen, zoomToBox }), [fitToScreen, zoomToBox]);

    // A new image (e.g. switching pages) must be re-measured and re-fitted, so
    // hide it again until its onLoad runs. Resetting here — rather than in
    // onLoad — avoids briefly showing the stale previous image under the new src.
    useEffect(() => {
        setIsReady(false);
    }, [fileUrl]);

    // --- Drawing Logic ---
    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        setNaturalSize({ width: naturalWidth, height: naturalHeight });
        setIsImageDark(estimateImageDarkness(e.currentTarget));
        // Start every freshly-loaded image at the fitted view.
        setCenter({ x: naturalWidth / 2, y: naturalHeight / 2 });
        onZoomChangeRef.current(1);
        // Reveal only after the fitted transform has been committed and painted,
        // so the first frame the user sees is already at the fit size. Flipping
        // isReady in a rAF (rather than synchronously here) guarantees the
        // transform doesn't change in the same render that turns transitions back
        // on, so the reveal is a clean fade — never an animated zoom.
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
            className={`relative h-full w-full overflow-hidden bg-surface-container-low ${isDragging ? 'cursor-grabbing' : activeTool === 'pan' ? 'cursor-grab' : ''}`}
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
                className="absolute left-0 top-0"
                style={{
                    transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
                    transformOrigin: '0 0',
                    boxShadow: imageShadow,
                    opacity: isReady && fitScale !== null ? 1 : 0,
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
                    // Deliberately no `crossOrigin`: `fileUrl` is a same-origin
                    // blob: URL (see useDocumentExtraction.ts), so the canvas in
                    // estimateImageDarkness stays untainted without it — and a
                    // CORS-mode request against a blob: URL never loads at all in
                    // WKWebView, which blanks the image *and* the overlay on macOS.
                    onLoad={handleImageLoad}
                    onError={onLoadError}
                    // Render at the image's intrinsic size; the derived transform
                    // handles all sizing. Any CSS cap here would make the layout size
                    // disagree with naturalSize, which the fit math relies on.
                    className="block w-auto max-w-none pointer-events-none select-none"
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
                        {overlayMode !== 'none' && words.map((word) => {
                            const color = getConfidenceColor(word.confidence);
                            const isHighlighted = highlightedWordId === word.id;
                            // Under the 'issues' mode, a high-confidence box is dimmed to
                            // fully invisible by default — still there (and interactive) on
                            // hover — so the ambient heatmap only draws the eye to what's
                            // actually uncertain.
                            const isDimmed = overlayMode === 'issues' && word.confidence >= OVERLAY_HIGH_CONFIDENCE;

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
                                            : isDimmed
                                                ? 'opacity-0 stroke-[2px] hover:opacity-40'
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
                            // A coarse box is drawn dashed and unfilled: the outline says
                            // "somewhere in here", and a solid fill would claim the whole
                            // region is the value. The title carries the same caveat for
                            // anyone hovering it.
                            <rect
                                x={provenanceHighlightBox.left - 2}
                                y={provenanceHighlightBox.top - 2}
                                width={provenanceHighlightBox.width + 4}
                                height={provenanceHighlightBox.height + 4}
                                className={highlightPrecision === 'coarse'
                                    ? `${highlightStroke} fill-none stroke-[2px]`
                                    : `${highlightFill} ${highlightStroke} stroke-[2px]`}
                                strokeDasharray={highlightPrecision === 'coarse' ? '8 6' : undefined}
                                style={{ pointerEvents: 'none', vectorEffect: 'non-scaling-stroke' }}
                            >
                                {highlightPrecision === 'coarse' && (
                                    <title>Approximate location — this page was read at region precision, so the source of this value is somewhere in this area.</title>
                                )}
                            </rect>
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
