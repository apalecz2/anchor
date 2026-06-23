import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeSetting } from '../../../lib/settings';
import type { Backend, SetupPaths } from '../types';
import Icon from '../../../components/Icon';

interface Props {
    backend: Backend;
    onLaunch: () => void;
}

export default function CompleteStep({ backend, onLaunch }: Props): React.ReactElement {
    const [ready, setReady] = useState(false);

    useEffect(() => {
        invoke<SetupPaths>('get_setup_paths').then(async paths => {
            writeSetting('llamaServerPath', paths.llama_server);
            writeSetting('modelPath', paths.model_path);
            writeSetting('mmprojPath', paths.mmproj_path);
            writeSetting('hardwareBackend', backend);
            // Also mirror the backend to AppData so a later launch from a different
            // webview origin (e.g. a packaged build that skips the wizard because the
            // shared AppData assets already exist) can restore it instead of falling
            // back to the cpu default and running generation on the CPU.
            await invoke('persist_backend', { backend }).catch(() => { /* non-fatal */ });
            setReady(true);
        });
    }, [backend]);

    return (
        <div className="flex flex-col gap-8 items-center text-center py-4">
            <Icon name="check_circle" size={64} fill={1} className="text-primary" />

            <div>
                <h2 className="font-display-sm text-display-sm text-on-surface">Setup complete</h2>
                <p className="font-body-lg text-body-lg text-on-surface-variant mt-2 max-w-md">
                    All components downloaded and verified. Anchor is ready to use.
                </p>
            </div>

            <div className="w-full rounded-[10px] border border-outline-variant bg-surface-container px-5 py-4 text-left">
                <p className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider mb-1">Backend</p>
                <p className="font-body-md text-body-md text-on-surface capitalize">{backend}</p>
            </div>

            <button
                type="button"
                disabled={!ready}
                onClick={onLaunch}
                className="flex items-center gap-2 px-8 py-3 rounded-lg bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
                <Icon name="rocket_launch" size={18} />
                Launch Anchor
            </button>
        </div>
    );
}
