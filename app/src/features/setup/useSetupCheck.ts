import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readSetting, writeSetting } from '../../lib/settings';

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
                // is the source of truth, so if assets are present but the model paths
                // in localStorage were lost (cleared storage, new WebView2 profile),
                // repopulate them from the canonical AppData locations rather than
                // booting into a broken state with no recovery UI.
                if (complete && !readSetting('modelPath')) {
                    try {
                        const paths = await invoke<{ llama_server: string; model_path: string; mmproj_path: string }>('get_setup_paths');
                        writeSetting('modelPath', paths.model_path);
                        writeSetting('mmprojPath', paths.mmproj_path);
                        writeSetting('llamaServerPath', paths.llama_server);
                    } catch {
                        /* non-fatal: startLlamaServer also falls back to get_setup_paths */
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
