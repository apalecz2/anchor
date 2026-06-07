import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AssetManifestEntry } from '../types';

interface Props {
    manifest: AssetManifestEntry[];
    onComplete: () => void;
    onError: (message: string) => void;
}

type VerifyStatus = 'pending' | 'checking' | 'ok' | 'failed';

export default function VerifyStep({ manifest, onComplete, onError }: Props): React.ReactElement {
    const [statuses, setStatuses] = useState<Record<string, VerifyStatus>>(
        Object.fromEntries(manifest.map(a => [a.asset_id, 'pending']))
    );
    const didStart = useRef(false);

    useEffect(() => {
        if (didStart.current) return;
        didStart.current = true;

        const run = async () => {
            for (const asset of manifest) {
                setStatuses(prev => ({ ...prev, [asset.asset_id]: 'checking' }));
                try {
                    const ok = await invoke<boolean>('verify_file_hash', {
                        path: asset.dest_path,
                        expectedSha256: asset.sha256,
                    });
                    if (!ok) {
                        setStatuses(prev => ({ ...prev, [asset.asset_id]: 'failed' }));
                        onError(`Hash mismatch for ${asset.label}. The file may be corrupted. Please re-run setup.`);
                        return;
                    }
                    setStatuses(prev => ({ ...prev, [asset.asset_id]: 'ok' }));
                } catch (err) {
                    setStatuses(prev => ({ ...prev, [asset.asset_id]: 'failed' }));
                    onError(`Verification failed for ${asset.label}: ${String(err)}`);
                    return;
                }
            }
            onComplete();
        };

        run();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const label: Record<VerifyStatus, string> = {
        pending:  'Waiting…',
        checking: 'Verifying…',
        ok:       'Verified',
        failed:   'Failed',
    };

    return (
        <div className="flex flex-col gap-8">
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">Verifying files</h2>
                <p className="font-body-md text-body-md text-on-surface-variant mt-1">
                    Checking SHA-256 hashes to confirm each download is intact.
                </p>
            </div>

            <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                {manifest.map(asset => {
                    const s = statuses[asset.asset_id] ?? 'pending';
                    return (
                        <div key={asset.asset_id} className="flex items-center gap-4 px-5 py-4">
                            <VerifyIcon status={s} />
                            <span className="flex-1 font-body-md text-body-md text-on-surface">{asset.label}</span>
                            <span className={`font-body-sm text-body-sm ${
                                s === 'ok' ? 'text-primary' : s === 'failed' ? 'text-error' : 'text-on-surface-variant'
                            }`}>
                                {label[s]}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function VerifyIcon({ status }: { status: VerifyStatus }): React.ReactElement {
    if (status === 'ok') return (
        <span
            className="material-symbols-outlined text-primary shrink-0"
            style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}
        >check_circle</span>
    );
    if (status === 'failed') return (
        <span className="material-symbols-outlined text-error shrink-0" style={{ fontSize: '20px' }}>error</span>
    );
    if (status === 'checking') return (
        <span className="material-symbols-outlined text-primary animate-spin shrink-0" style={{ fontSize: '20px' }}>progress_activity</span>
    );
    return (
        <span className="material-symbols-outlined text-on-surface-variant/40 shrink-0" style={{ fontSize: '20px' }}>radio_button_unchecked</span>
    );
}
