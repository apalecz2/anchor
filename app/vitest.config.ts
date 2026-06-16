import { defineConfig } from 'vitest/config';

// Pure-logic unit tests only (provenance, confidence, TSV parsing, export
// serializers, OCR transforms) — no DOM, so the lightweight node environment is
// enough and we don't pull in the Tauri/React plugins the app build uses.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
});
