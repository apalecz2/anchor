// Centralized test-data builders (TEST_PLAN §12). Importing these instead of
// re-declaring a `word()`/cell factory in every spec keeps fixtures consistent and
// makes a test's *intent* (the field it overrides) the only thing on screen.
//
// Only types are imported, so this module is safe in both the node (`unit`) and
// jsdom (`dom`) Vitest projects.
import type { OcrWord } from '../features/ocr/types';
import type {
    ProvenanceCell,
    TrustLevel,
    AgreementStatus,
} from '../features/extraction/types';
import type { HardwareInfo } from '../features/setup/types';

let seq = 0;
/** Reset the auto-incrementing id counter — call in `beforeEach` for deterministic ids. */
export const resetFixtureIds = (): void => {
    seq = 0;
};

/** An OCR word with an auto-assigned stable id. Positional args match the most
 *  common spec usage: `ocrWord('Math', left, top, width?, height?)`. */
export const ocrWord = (
    text: string,
    left = 0,
    top = 0,
    width = 10,
    height = 10,
    confidence = 90,
): OcrWord => ({
    id: `w${seq++}`,
    text,
    confidence,
    box_coords: { left, top, width, height },
});

/** A scored provenance cell. Override only the fields a test cares about. */
export const provenanceCell = (
    value: string,
    over: {
        rowIndex?: number;
        colIndex?: number;
        trust?: TrustLevel;
        agreement?: AgreementStatus;
        matchStatus?: ProvenanceCell['matchStatus'];
        wordIds?: string[];
        llmMean?: number | null;
        llmMin?: number | null;
        ocr?: number | null;
    } = {},
): ProvenanceCell => ({
    rowIndex: over.rowIndex ?? 0,
    colIndex: over.colIndex ?? 0,
    value,
    wordIds: over.wordIds ?? [],
    matchStatus: over.matchStatus ?? 'matched',
    confidence: {
        llmMean: 'llmMean' in over ? over.llmMean! : 0.9,
        llmMin: 'llmMin' in over ? over.llmMin! : 0.9,
        ocr: over.ocr ?? 90,
        agreement: over.agreement ?? 'agree',
        trust: over.trust ?? 'high',
    },
});

/** Detected hardware; defaults to a plain Windows CPU box. */
export const hardwareInfo = (over: Partial<HardwareInfo> = {}): HardwareInfo => ({
    gpu_name: null,
    gpu_vendor: null,
    vram_mb: null,
    ram_mb: 8192,
    recommended_backend: 'cpu',
    os: 'windows',
    available_backends: ['cpu'],
    ...over,
});
