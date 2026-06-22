import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
    useSetupCheck,
    requestSetupRerun,
    clearSetupRerun,
    FORCE_SETUP_KEY,
} from './useSetupCheck';
import { readSetting, hasSetting } from '../../lib/settings';

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
});

describe('useSetupCheck', () => {
    it('treats the force_setup flag as incomplete regardless of assets', async () => {
        localStorage.setItem(FORCE_SETUP_KEY, '1');
        const { result } = renderHook(() => useSetupCheck());
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.isComplete).toBe(false);
        expect(invoke).not.toHaveBeenCalledWith('check_setup_complete');
    });

    it('reports complete when check_setup_complete is true and paths already exist', async () => {
        localStorage.setItem('model_path', '/m.gguf');
        localStorage.setItem('hardware_backend', 'cuda');
        invoke.mockResolvedValueOnce(true); // check_setup_complete
        const { result } = renderHook(() => useSetupCheck());
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.isComplete).toBe(true);
        // No heal needed -> get_setup_paths not called.
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('auto-heals missing paths and backend from get_setup_paths (F5)', async () => {
        // complete, but localStorage lost its settings.
        invoke
            .mockResolvedValueOnce(true) // check_setup_complete
            .mockResolvedValueOnce({
                llama_server: '/bin/llama',
                model_path: '/models/q.gguf',
                mmproj_path: '/models/mmproj.gguf',
                hardware_backend: 'metal',
            }); // get_setup_paths
        const { result } = renderHook(() => useSetupCheck());
        await waitFor(() => expect(result.current.isComplete).toBe(true));
        expect(readSetting('modelPath')).toBe('/models/q.gguf');
        expect(readSetting('llamaServerPath')).toBe('/bin/llama');
        expect(hasSetting('hardwareBackend')).toBe(true);
        expect(readSetting('hardwareBackend')).toBe('metal');
    });

    it('falls back to detect_hardware recommendation when no backend was persisted', async () => {
        localStorage.setItem('model_path', '/m.gguf'); // paths fine, only backend missing
        invoke
            .mockResolvedValueOnce(true) // check_setup_complete
            .mockResolvedValueOnce({
                llama_server: '/b',
                model_path: '/m.gguf',
                mmproj_path: '/mm',
                hardware_backend: null,
            }) // get_setup_paths
            .mockResolvedValueOnce({ recommended_backend: 'cuda' }); // detect_hardware
        const { result } = renderHook(() => useSetupCheck());
        await waitFor(() => expect(result.current.isComplete).toBe(true));
        expect(readSetting('hardwareBackend')).toBe('cuda');
    });

    it('reports incomplete when the invoke throws', async () => {
        invoke.mockRejectedValueOnce(new Error('no backend'));
        const { result } = renderHook(() => useSetupCheck());
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.isComplete).toBe(false);
    });

    it('requestSetupRerun sets the flag and clearSetupRerun removes it', () => {
        // requestSetupRerun reloads — stub it.
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { ...window.location, reload: vi.fn() },
        });
        act(() => requestSetupRerun());
        expect(localStorage.getItem(FORCE_SETUP_KEY)).toBe('1');
        clearSetupRerun();
        expect(localStorage.getItem(FORCE_SETUP_KEY)).toBeNull();
    });
});
