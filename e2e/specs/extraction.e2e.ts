import { browser, $, expect } from '@wdio/globals';
import path from 'node:path';

// TEST_PLAN §7 journey 4: Core extraction loop.
// Assumes setup is already complete (assets present in AppData) and uses a tiny
// bundled GGUF + a fixture table PNG with asserted-stable output, or a stubbed
// llama-server endpoint. Fixtures live in e2e/fixtures/ (see fixtures/README.md).
describe('Core extraction loop', () => {
    it('uploads a table image, formats it, and highlights a cell on the source', async () => {
        // Upload the fixture table PNG via the hidden file input.
        const fixture = path.resolve(import.meta.dirname, '..', 'fixtures', 'table.png');
        const fileInput = await $('input[type="file"]');
        await fileInput.setValue(fixture);

        // OCR runs → words render → the document viewer appears.
        const viewer = await $('svg, canvas, [data-testid="document-viewer"]');
        await viewer.waitForExist({ timeout: 60_000 });

        // Format as Table → the provenance table appears.
        const formatBtn = await $('button*=Format as Table, button*=Format');
        await formatBtn.click();
        const table = await $('table');
        await table.waitForExist({ timeout: 120_000 });

        // Click a data cell → its source box highlights on the image.
        const firstDataCell = await $('table tbody tr td');
        await firstDataCell.click();
        const highlight = await $('rect[stroke], [data-testid="source-highlight"]');
        await expect(highlight).toBeExisting();

        // Export is enabled once there is data.
        const exportBtn = await $('button*=Export');
        await expect(exportBtn).toBeEnabled();
    });
});
