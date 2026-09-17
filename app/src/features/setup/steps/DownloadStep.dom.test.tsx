import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        onCloseRequested: vi.fn(async () => vi.fn()),
        destroy: vi.fn(async () => {}),
    }),
}));

import DownloadStep from './DownloadStep';
import type { SetupConfig } from '../types';

const config = (backend: SetupConfig['backend']): SetupConfig => ({ backend });

/** Order of the Tauri commands the step issued. */
const commands = () => invoke.mock.calls.map(c => c[0] as string);

beforeEach(() => {
    vi.clearAllMocks();
    // Everything already installed, so the run reaches completion without downloading.
    invoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_asset_manifest') {
            return Promise.resolve([
                { asset_id: 'llama_server', label: 'llama', size_bytes: 1, dest_path: '/a', sha256: '', url_primary: 'u', url_fallback: null, extract_to_dir: null, flatten_marker: null, installed: true, version: null },
            ]);
        }
        return Promise.resolve(undefined);
    });
});

describe('DownloadStep', () => {
    /**
     * `check_setup_complete` decides whether the CUDA runtime is required from the
     * backend recorded in AppData. CompleteStep writes it too, but only on success —
     * so an install that dies partway (the case the check exists for) would leave it
     * unwritten, and a CUDA install missing cudart would read as complete.
     */
    it('records the backend before fetching the manifest, not after the install', async () => {
        render(<DownloadStep config={config('cuda')} onComplete={vi.fn()} onError={vi.fn()} onCancel={vi.fn()} />);

        await waitFor(() => expect(invoke).toHaveBeenCalledWith('persist_backend', { backend: 'cuda' }));
        const order = commands();
        expect(order.indexOf('persist_backend')).toBeLessThan(order.indexOf('get_asset_manifest'));
    });

    it('records a cpu backend just the same', async () => {
        render(<DownloadStep config={config('cpu')} onComplete={vi.fn()} onError={vi.fn()} onCancel={vi.fn()} />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('persist_backend', { backend: 'cpu' }));
    });

    it('still installs when the backend cannot be persisted', async () => {
        // Non-fatal: the completeness check just falls back to not requiring cudart.
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'persist_backend') return Promise.reject('read-only volume');
            if (cmd === 'get_asset_manifest') return Promise.resolve([]);
            return Promise.resolve(undefined);
        });
        const onComplete = vi.fn();
        const onError = vi.fn();
        render(<DownloadStep config={config('cuda')} onComplete={onComplete} onError={onError} onCancel={vi.fn()} />);

        await waitFor(() => expect(onComplete).toHaveBeenCalled());
        expect(onError).not.toHaveBeenCalled();
    });

    /**
     * A failure unmounts the whole step in favour of the wizard's error screen, so
     * the per-asset 'error' status the list used to carry was never seen by anyone
     * — the screen showed the backend's raw text alone ("hash mismatch for
     * cudart", or a bare transport error) and left the user to guess which of six
     * downloads had died.
     */
    it('names the component that failed, not just the backend error', async () => {
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_asset_manifest') {
                return Promise.resolve([
                    { asset_id: 'cudart', label: 'CUDA runtime (391 MB)', size_bytes: 1, dest_path: '/a', sha256: '', url_primary: 'u', url_fallback: null, extract_to_dir: null, flatten_marker: null, installed: false, version: null },
                ]);
            }
            if (cmd === 'download_file') return Promise.reject('hash mismatch for cudart');
            return Promise.resolve(undefined);
        });
        const onError = vi.fn();
        render(<DownloadStep config={config('cuda')} onComplete={vi.fn()} onError={onError} onCancel={vi.fn()} />);

        await waitFor(() => expect(onError).toHaveBeenCalled());
        const message = onError.mock.calls[0][0] as string;
        expect(message).toContain('CUDA runtime');   // named, without its size suffix
        expect(message).not.toContain('391 MB');
        expect(message).toContain('hash mismatch for cudart');  // the cause is kept
        expect(message).not.toMatch(/^Error:/);      // not a stringified Error object
    });

    it('names the component when its archive fails to unpack', async () => {
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_asset_manifest') {
                return Promise.resolve([
                    { asset_id: 'tesseract', label: 'Tesseract OCR', size_bytes: 1, dest_path: '/a', sha256: '', url_primary: 'u', url_fallback: null, extract_to_dir: '/out', flatten_marker: null, installed: false, version: null },
                ]);
            }
            if (cmd === 'extract_archive') return Promise.reject('archive is corrupt');
            return Promise.resolve(undefined);
        });
        const onError = vi.fn();
        render(<DownloadStep config={config('cpu')} onComplete={vi.fn()} onError={onError} onCancel={vi.fn()} />);

        await waitFor(() => expect(onError).toHaveBeenCalled());
        expect(onError.mock.calls[0][0]).toContain('Tesseract OCR');
    });

    it('asks for the manifest matching the chosen backend', async () => {
        render(<DownloadStep config={config('cuda')} onComplete={vi.fn()} onError={vi.fn()} onCancel={vi.fn()} />);
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('get_asset_manifest', { backend: 'cuda', presetId: null }),
        );
    });

    it('records the chosen preset before downloading, and asks for its manifest', async () => {
        // The preset decides which assets the install needs, so it has to be on disk
        // before the first byte — an install that fails partway is exactly the case
        // `check_setup_complete` exists for, and it reads this file.
        const withPreset: SetupConfig = { backend: 'cpu', presetId: 'tesseract-qwen3.5-4b' };
        render(<DownloadStep config={withPreset} onComplete={vi.fn()} onError={vi.fn()} onCancel={vi.fn()} />);
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('get_asset_manifest', {
                backend: 'cpu',
                presetId: 'tesseract-qwen3.5-4b',
            }),
        );
        expect(invoke).toHaveBeenCalledWith('persist_preset', { presetId: 'tesseract-qwen3.5-4b' });
        expect(commands().indexOf('persist_preset'))
            .toBeLessThan(commands().indexOf('get_asset_manifest'));
    });

    it('omits the preset entirely when the config names none', async () => {
        // An install with no preset chosen must not write one: the backend falls back
        // to the catalog default on its own, and recording a guess as though the user
        // had picked it would outlive the guess.
        render(<DownloadStep config={config('cpu')} onComplete={vi.fn()} onError={vi.fn()} onCancel={vi.fn()} />);
        await waitFor(() => expect(commands()).toContain('get_asset_manifest'));
        expect(commands()).not.toContain('persist_preset');
    });
});
