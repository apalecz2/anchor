import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import CompleteStep from './CompleteStep';
import { readSetting } from '../../../lib/settings';

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
});

describe('CompleteStep', () => {
    it('writes resolved paths + backend, persists the backend, and enables Launch', async () => {
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_setup_paths')
                return Promise.resolve({
                    llama_server: '/bin/llama',
                    model_path: '/models/q.gguf',
                    mmproj_path: '/models/mm.gguf',
                    hardware_backend: 'cuda',
                });
            if (cmd === 'persist_backend') return Promise.resolve(undefined);
            return Promise.resolve(undefined);
        });

        const onLaunch = vi.fn();
        render(<CompleteStep backend="cuda" onLaunch={onLaunch} />);

        await waitFor(() => expect(readSetting('modelPath')).toBe('/models/q.gguf'));
        expect(readSetting('llamaServerPath')).toBe('/bin/llama');
        expect(readSetting('mmprojPath')).toBe('/models/mm.gguf');
        expect(readSetting('hardwareBackend')).toBe('cuda');
        expect(invoke).toHaveBeenCalledWith('persist_backend', { backend: 'cuda' });

        const launch = screen.getByRole('button', { name: /Launch Anchor/ });
        await waitFor(() => expect(launch).toBeEnabled());
        fireEvent.click(launch);
        expect(onLaunch).toHaveBeenCalled();
    });
});
