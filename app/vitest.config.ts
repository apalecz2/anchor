import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Two Vitest projects so pure-logic stays node-fast while component tests get a
// DOM (TEST_PLAN §4.1). The single discriminator is the filename:
//   Tier 1 → *.test.ts           (node, no DOM)
//   Tier 2 → *.dom.test.{ts,tsx} (jsdom + Testing Library)
export default defineConfig({
    plugins: [react()],
    test: {
        projects: [
            {
                plugins: [react()],
                test: {
                    name: 'unit',
                    environment: 'node',
                    include: ['src/**/*.test.ts'],
                    exclude: ['src/**/*.dom.test.{ts,tsx}'],
                },
            },
            {
                plugins: [react()],
                test: {
                    name: 'dom',
                    environment: 'jsdom',
                    include: ['src/**/*.dom.test.{ts,tsx}'],
                    setupFiles: ['src/test/setup.ts'],
                },
            },
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['src/**'],
            exclude: ['src/**/*.test.*', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
            // Per-file ratchets on the pure-logic core — "these are the product"
            // (TEST_PLAN §11). Set as floors just below current coverage so a
            // regression fails CI without being flaky. Components/pages are not
            // globally gated yet (they accrue coverage as §6.2/6.3 fill in).
            thresholds: {
                'src/features/extraction/provenance.ts': { statements: 95, branches: 80, functions: 95, lines: 95 },
                'src/features/extraction/confidence.ts': { statements: 95, branches: 90, functions: 100, lines: 95 },
                'src/utils/ocrTransforms.ts': { statements: 95, branches: 75, functions: 100, lines: 95 },
                'src/features/export/exportUtils.ts': { statements: 80, branches: 80, functions: 90, lines: 80 },
                'src/features/llama/contextBudget.ts': { statements: 100, branches: 90, functions: 100, lines: 100 },
                'src/features/setup/backend.ts': { statements: 100, branches: 90, functions: 100, lines: 100 },
            },
        },
    },
});
