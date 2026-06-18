import React, { useState, useRef, useEffect } from 'react';

export const SplitLayout = ({ children }: { children: React.ReactNode }) => {
    const [leftWidth, setLeftWidth] = useState(50);
    const containerRef = useRef<HTMLDivElement>(null);
    const isDragging = useRef(false);

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

    const leftPane = React.Children.toArray(children)[0];
    const rightPane = React.Children.toArray(children)[1];

    return (
        <main className="relative flex h-full w-full overflow-hidden bg-background">
            <div className="flex h-full w-full" ref={containerRef}>
                <div className="@container flex h-full flex-col bg-surface-container-lowest transition-[width] duration-0 py-4 px-6" style={{ width: `${leftWidth}%` }}>
                    {leftPane}
                </div>
                <div
                    className="group relative flex w-5 shrink-0 cursor-col-resize select-none items-center justify-center"
                    onMouseDown={() => isDragging.current = true}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize panes"
                >
                    {/* Pane-colored halves so each side of the gutter blends into its pane */}
                    <div className="absolute inset-y-0 left-0 w-1/2 bg-surface-container-lowest" />
                    <div className="absolute inset-y-0 right-0 w-1/2 bg-background" />
                    {/* Full-height guide line so the split is always visible */}
                    <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-outline-variant transition-colors group-hover:bg-primary/40" />
                    {/* Grip handle that signals the bar is draggable */}
                    <div className="relative flex h-14 w-5 items-center justify-center rounded-full border border-outline-variant bg-surface-variant shadow-sm transition-colors group-hover:border-primary group-hover:bg-surface-container-high">
                        <span className="material-symbols-outlined text-[18px] leading-none text-on-surface-variant transition-colors group-hover:text-primary">
                            drag_indicator
                        </span>
                    </div>
                </div>
                <div className="@container flex h-full flex-col transition-[width] duration-0 py-4 px-6" style={{ width: `${100 - leftWidth}%` }}>
                    {rightPane}
                </div>
            </div>
        </main>
    );
};