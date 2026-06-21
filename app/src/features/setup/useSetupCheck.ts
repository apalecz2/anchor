import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { hasSetting, readSetting, writeSetting } from '../../lib/settings';
import type { Backend, HardwareInfo, SetupPaths } from './types';

interface SetupCheckState {
    isComplete: boolean;
    isLoading: boolean;
}

/** When set in localStorage, the wizard is shown even if assets are already on
 *  disk. This is the user-facing "re-run setup" escape hatch (Settings), and the
 *  recovery path when the on-disk install is fine but settings were lost. */
export const FORCE_SETUP_KEY = 'force_setup';

/** Trigger the setup wizard on next load. Used by the Settings escape hatch. */
export function requestSetupRerun(): void {
    localStorage.setItem(FORCE_SETUP_KEY, '1');
    window.location.reload();
}

/** Clear the force-setup flag once the wizard has completed. */
export function clearSetupRerun(): void {
    localStorage.removeItem(FORCE_SETUP_KEY);
}

export function useSetupCheck(): SetupCheckState {
    const [state, setState] = useState<SetupCheckState>({ isComplete: false, isLoading: true });

    useEffect(() => {
        let cancelled = false;

        async function check() {
            // Explicit re-run request always wins, even when assets exist.
            if (localStorage.getItem(FORCE_SETUP_KEY) === '1') {
                if (!cancelled) setState({ isComplete: false, isLoading: false });
                return;
            }

            try {
                const complete = await invoke<boolean>('check_setup_complete');

                // Auto-heal the settings/files split (review F5): the on-disk install
                // is the source of truth, so if assets are present but settings in
                // localStorage were lost (cleared storage, new WebView2 profile, or a
                // packaged build whose per-origin store never saw the wizard), repopulate
                // them from AppData rather than booting into a degraded state.
                //
                // The two repairs are gated independently: model paths key off a missing
                // `modelPath`, but the backend keys off `hasSetting` (not `readSetting`)
                // because its default is `cpu` — a value `readSetting` always returns, so
                // it can't reveal a never-set backend. Conflating the two (the original
                // bug) meant an install that had already healed its paths on a prior launch
                // would never restore the backend, leaving llama-server on `--n-gpu-layers
                // 0` (CPU-only generation) despite a GPU build being installed.
                if (complete) {
                    const needPaths = !readSetting('modelPath');
                    const needBackend = !hasSetting('hardwareBackend');
                    if (needPaths || needBackend) {
                        try {
                            const paths = await invoke<SetupPaths>('get_setup_paths');
                            if (needPaths) {
                                writeSetting('modelPath', paths.model_path);
                                writeSetting('mmprojPath', paths.mmproj_path);
                                writeSetting('llamaServerPath', paths.llama_server);
                            }
                            if (needBackend) {
                                // Prefer the backend the wizard persisted to disk; an older
                                // install that predates that file falls back to the detected
                                // recommendation so a GPU machine still offloads.
                                let backend: Backend | null = paths.hardware_backend;
                                if (!backend) {
                                    backend = await invoke<HardwareInfo>('detect_hardware')
                                        .then(hw => hw.recommended_backend)
                                        .catch(() => null);
                                }
                                if (backend) writeSetting('hardwareBackend', backend);
                            }
                        } catch {
                            /* non-fatal: startLlamaServer also falls back to get_setup_paths */
                        }
                    }
                }

                if (!cancelled) setState({ isComplete: complete, isLoading: false });
            } catch {
                if (!cancelled) setState({ isComplete: false, isLoading: false });
            }
        }

        check();
        return () => { cancelled = true; };
    }, []);

    return state;
}
