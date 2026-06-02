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
                <div className="flex h-full flex-col bg-surface-container-lowest transition-[width] duration-0 py-4 px-6" style={{ width: `${leftWidth}%` }}>
                    {leftPane}
                </div>
                <div className="group relative flex w-3 cursor-col-resize items-center justify-center" onMouseDown={() => isDragging.current = true}>
                    <div className="h-12 w-1 rounded-full bg-outline-variant group-hover:bg-primary" />
                </div>
                <div className="flex h-full flex-col transition-[width] duration-0 py-4 px-6" style={{ width: `${100 - leftWidth}%` }}>
                    {rightPane}
                </div>
            </div>
        </main>
    );
};