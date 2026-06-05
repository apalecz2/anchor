import React from "react";
import type { BoundingBox } from "../ocr/types";
import type { ValidatedCell } from "./pipeFormat";

// ---------------------------------------------------------------------------
// ProvenanceRect — drop inside the DocumentViewer SVG as provenanceOverlay.
// Normal refs use a solid blue stroke; ref_mismatch uses a dashed amber stroke
// so the human verifier knows the source word doesn't match the value.
// ---------------------------------------------------------------------------

interface ProvenanceRectProps {
    box: BoundingBox;
    refStatus: ValidatedCell["refStatus"];
}

export const ProvenanceRect: React.FC<ProvenanceRectProps> = ({ box, refStatus }) => {
    const isMismatch = refStatus === "ref_mismatch";
    const stroke = isMismatch ? "#f59e0b" : "#3b82f6"; // amber-400 : blue-500

    return (
        <rect
            x={box.left}
            y={box.top}
            width={box.width}
            height={box.height}
            fill={stroke}
            fillOpacity={0.15}
            stroke={stroke}
            strokeWidth={3}
            strokeDasharray={isMismatch ? "6 3" : undefined}
            pointerEvents="none"
        />
    );
};

// ---------------------------------------------------------------------------
// CellProvenanceBadge — render inline in a table cell.
// Shows nothing for "ok" refs (provenance is implicit from the highlight).
// Shows a muted badge for image_only; a warning badge for ref_mismatch.
// ---------------------------------------------------------------------------

interface CellProvenanceBadgeProps {
    refStatus: ValidatedCell["refStatus"];
}

export const CellProvenanceBadge: React.FC<CellProvenanceBadgeProps> = ({ refStatus }) => {
    if (refStatus === "image_only") {
        return (
            <span
                title="Value read from image — no matching OCR word"
                className="ml-1 inline-block rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-surface-variant text-on-surface-variant"
            >
                image-derived
            </span>
        );
    }

    if (refStatus === "ref_mismatch") {
        return (
            <span
                title="LLM cited an OCR word whose text doesn't match this value — verify"
                className="ml-1 inline-block rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-error/10 text-error"
            >
                ref mismatch
            </span>
        );
    }

    return null;
};
