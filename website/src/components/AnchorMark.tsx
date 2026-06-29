import React from 'react';

/* ─────────────────────────────────────────────────────────────────────────
   Anchor brand mark — the registration-guide anchor from the brand sheet,
   rendered inline as a rounded tile that inverts with the theme:

     · light mode → reversed variant:   paper anchor on an ink tile
     · dark mode  → monochrome variant:  ink anchor on a white tile

   In both cases the tile contrasts with the page surface so the mark reads
   crisply. The guides cross the full field; a tile-coloured mask circle
   clears the centre so the anchor letterform sits cleanly on top.

   Colours are written as literal Tailwind classes (not interpolated) so the
   v4 source scanner generates them. Ink = #16202E, paper = #F3F1EA — the
   geometry is copied verbatim from the Anchor brand sheet.
   ───────────────────────────────────────────────────────────────────────── */

// Anchor letterform — body plus the top ball, from the brand sheet `ancP` path.
// Authored on the Material 960 grid (viewBox "0 -960 960 960"); also reused by
// the runtime favicon painter so the tab icon matches this mark exactly.
export const ANCHOR_PATH =
    'M349.02-95.3q-65.43-22.72-117.31-62.28-51.88-39.55-84.55-93.06-32.66-53.51-32.66-114.86v-78.09q0-13.91 12.43-20.51 12.44-6.6 23.87 2.36l95.55 71.11q16.15 12.43 17.77 33.45 1.62 21.01-13.05 35.68l-26.14 26.13q28.53 48.37 87.22 83.22 58.7 34.85 122.35 44.85v-343.37H360q-19.15 0-32.33-13.18-13.17-13.17-13.17-32.32 0-19.16 13.17-32.33 13.18-13.17 32.33-13.17h74.5v-41.74q-37.15-14.68-60.37-47.09-23.22-32.41-23.22-73.09 0-53.82 37.63-91.57 37.63-37.75 91.46-37.75 53.83 0 91.46 37.75 37.63 37.75 37.63 91.57 0 40.68-23.22 73.09-23.22 32.41-60.37 47.09v41.74H600q19.15 0 32.33 13.17 13.17 13.17 13.17 32.33 0 19.15-13.17 32.32-13.18 13.18-32.33 13.18h-74.5v343.37q63.65-10 122.35-44.85 58.69-34.85 87.22-83.22l-26.14-26.13q-14.67-14.67-13.05-35.68 1.62-21.02 17.77-33.45l95.55-71.11q11.43-8.96 23.87-2.36 12.43 6.6 12.43 20.51v78.09q0 61.35-32.66 114.86-32.67 53.51-84.55 93.06-51.88 39.56-117.31 62.28Q545.54-72.59 480-72.59q-65.54 0-130.98-22.71ZM480-725.5q16.28 0 27.18-10.9 10.91-10.9 10.91-27.19 0-16.28-10.91-27.3-10.9-11.02-27.18-11.02t-27.18 11.02q-10.91 11.02-10.91 27.3 0 16.29 10.91 27.19 10.9 10.9 27.18 10.9Z';

export default function AnchorMark({ className = '' }: { className?: string }): React.ReactElement {
    return (
        <span
            aria-hidden
            className={`inline-flex items-center justify-center overflow-hidden bg-[#16202E] dark:bg-white ${className}`}
        >
            <svg viewBox="0 0 240 240" className="w-full h-full" role="presentation">
                {/* Registration guides — full crosshair + corner brackets. */}
                <g
                    className="stroke-[#F3F1EA]/35 dark:stroke-[#16202E]/30"
                    strokeWidth={4}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <line x1="42" y1="120" x2="198" y2="120" />
                    <line x1="120" y1="42" x2="120" y2="198" />
                    <path d="M44 66 V44 H66" />
                    <path d="M174 44 H196 V66" />
                    <path d="M44 174 V196 H66" />
                    <path d="M196 174 V196 H174" />
                </g>
                {/* Mask circle — matches the tile so guides clear the anchor. */}
                <circle cx="120" cy="120" r="66" className="fill-[#16202E] dark:fill-white" />
                {/* Anchor letterform. */}
                <g transform="translate(60,180) scale(0.125)" className="fill-[#F3F1EA] dark:fill-[#16202E]">
                    <path d={ANCHOR_PATH} />
                </g>
            </svg>
        </span>
    );
}
