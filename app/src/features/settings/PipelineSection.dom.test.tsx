import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import PipelineSection from './PipelineSection';

const fast = {
    id: 'tesseract-qwen3.5-4b',
    label: 'Fast',
    description: 'Tesseract reads the page, Qwen3.5 4B builds the table.',
    download_mb: 3255,
    min_ram_mb: 7500,
    min_vram_mb: null,
    supported: true,
    installed: true,
    selected: true,
};
const accurate = {
    id: 'tesseract-surya-qwen3.5-4b',
    label: 'Accurate',
    description: 'Tesseract reads the page, Surya maps the table, Qwen builds it.',
    download_mb: 4727,
    min_ram_mb: 15000,
    min_vram_mb: null,
    supported: true,
    installed: true,
    selected: false,
};

beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockImplementation((cmd: string) =>
        Promise.resolve(cmd === 'list_pipeline_presets' ? [accurate, fast] : undefined));
});

describe('PipelineSection', () => {
    it('lists each pipeline with its download size and marks the selected one', async () => {
        render(<PipelineSection />);
        await waitFor(() => expect(screen.getByText('Accurate')).toBeTruthy());
        expect(screen.getByText('Fast')).toBeTruthy();
        expect(screen.getByText(/4\.7 GB of models/)).toBeTruthy();

        const radios = screen.getAllByRole('radio') as HTMLInputElement[];
        expect(radios.map(r => r.checked)).toEqual([false, true]); // Accurate, Fast
    });

    it('persists the choice when a different pipeline is picked', async () => {
        render(<PipelineSection />);
        await waitFor(() => expect(screen.getByText('Accurate')).toBeTruthy());

        fireEvent.click(screen.getAllByRole('radio')[0]);
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('persist_preset', {
                presetId: 'tesseract-surya-qwen3.5-4b',
            }));
    });

    it('reverts the selection when the write fails', async () => {
        // The radio moves optimistically so it responds under the cursor. If the write
        // failed, leaving it moved would show a choice that was never recorded — and
        // the next launch would quietly run the other pipeline.
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'list_pipeline_presets') return Promise.resolve([accurate, fast]);
            if (cmd === 'persist_preset') return Promise.reject('read-only volume');
            return Promise.resolve(undefined);
        });
        render(<PipelineSection />);
        await waitFor(() => expect(screen.getByText('Accurate')).toBeTruthy());

        fireEvent.click(screen.getAllByRole('radio')[0]);
        expect((await screen.findByRole('alert')).textContent).toContain('read-only volume');
        const radios = screen.getAllByRole('radio') as HTMLInputElement[];
        expect(radios.map(r => r.checked)).toEqual([false, true]);
    });

    it('warns that an un-downloaded pipeline sends the user back to setup', async () => {
        invoke.mockImplementation((cmd: string) =>
            Promise.resolve(cmd === 'list_pipeline_presets'
                ? [{ ...accurate, installed: false }, fast]
                : undefined));
        render(<PipelineSection />);
        expect(await screen.findByText(/returns to setup/)).toBeTruthy();
    });

    it('shows an unsupported pipeline rather than hiding it', async () => {
        // A user comparing options needs to see what their machine rules out, and why.
        invoke.mockImplementation((cmd: string) =>
            Promise.resolve(cmd === 'list_pipeline_presets'
                ? [{ ...accurate, supported: false }, fast]
                : undefined));
        render(<PipelineSection />);
        expect(await screen.findByText('Accurate')).toBeTruthy();
        expect(screen.getByText(/reports less/)).toBeTruthy();
    });

    it('states the single pipeline plainly instead of drawing a one-item radio list', async () => {
        invoke.mockImplementation((cmd: string) =>
            Promise.resolve(cmd === 'list_pipeline_presets' ? [fast] : undefined));
        render(<PipelineSection />);
        await waitFor(() => expect(screen.getByText(/Anchor runs the Fast pipeline/)).toBeTruthy());
        expect(screen.queryAllByRole('radio')).toHaveLength(0);
    });
});
