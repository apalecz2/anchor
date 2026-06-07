import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AssetManifestEntry, AssetProgress, SetupConfig } from '../types';

interface Props {
    config: SetupConfig;
    onComplete: (manifest: AssetManifestEntry[]) => void;
    onError: (message: string) => void;
}

interface ProgressEvent {
    asset_id: string;
    bytes_received: number;
    total_bytes: number | null;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}

export default function DownloadStep({ config, onComplete, onError }: Props): React.ReactElement {
    const [manifest, setManifest] = useState<AssetManifestEntry[]>([]);
    const [progress, setProgress] = useState<Record<string, AssetProgress>>({});
    const [currentIdx, setCurrentIdx] = useState(0);
    const [started, setStarted] = useState(false);
    const didStart = useRef(false);

    // Load manifest then begin sequential downloads
    useEffect(() => {
        if (didStart.current) return;
        didStart.current = true;

        const run = async () => {
            let unlistenFn: (() => void) | undefined;

            try {
                const entries = await invoke<AssetManifestEntry[]>('get_asset_manifest', {
                    backend: config.backend,
                });
                setManifest(entries);

                const initialProgress: Record<string, AssetProgress> = {};
                entries.forEach(e => { initialProgress[e.asset_id] = { status: 'pending', bytes_received: 0, total_bytes: e.size_bytes }; });
                setProgress(initialProgress);
                setStarted(true);

                // Listen for progress events from Rust
                unlistenFn = await listen<ProgressEvent>('setup:progress', (event) => {
                    const { asset_id, bytes_received, total_bytes } = event.payload;
                    setProgress(prev => ({
                        ...prev,
                        [asset_id]: { ...prev[asset_id], status: 'downloading', bytes_received, total_bytes },
                    }));
                });

                // Download sequentially
                for (let i = 0; i < entries.length; i++) {
                    const asset = entries[i];
                    setCurrentIdx(i);
                    setProgress(prev => ({ ...prev, [asset.asset_id]: { ...prev[asset.asset_id], status: 'downloading' } }));

                    try {
                        await invoke('download_file', {
                            url: asset.url_primary,
                            destPath: asset.dest_path,
                            assetId: asset.asset_id,
                        });
                    } catch (primaryErr) {
                        if (asset.url_fallback) {
                            await invoke('download_file', {
                                url: asset.url_fallback,
                                destPath: asset.dest_path,
                                assetId: asset.asset_id,
                            });
                        } else {
                            throw primaryErr;
                        }
                    }

                    if (asset.extract_to_dir) {
                        setProgress(prev => ({
                            ...prev,
                            [asset.asset_id]: { ...prev[asset.asset_id], status: 'extracting' },
                        }));
                        await invoke('extract_zip', {
                            archivePath: asset.dest_path,
                            destDir: asset.extract_to_dir,
                        });
                    }

                    setProgress(prev => ({
                        ...prev,
                        [asset.asset_id]: { ...prev[asset.asset_id], status: 'done', bytes_received: asset.size_bytes },
                    }));
                }

                onComplete(entries);
            } catch (err) {
                onError(String(err));
            } finally {
                unlistenFn?.();
            }
        };

        run();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="flex flex-col gap-8">
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">Downloading</h2>
                <p className="font-body-md text-body-md text-on-surface-variant mt-1">
                    Do not close the app while downloads are in progress.
                </p>
            </div>

            <div className="flex flex-col gap-4">
                {manifest.length === 0 && (
                    <div className="flex items-center gap-3 text-on-surface-variant font-body-md text-body-md">
                        <span className="material-symbols-outlined animate-spin" style={{ fontSize: '20px' }}>progress_activity</span>
                        Preparing download list…
                    </div>
                )}
                {manifest.map((asset, idx) => {
                    const p = progress[asset.asset_id];
                    const pct = p && p.total_bytes
                        ? Math.min(100, Math.round((p.bytes_received / p.total_bytes) * 100))
                        : 0;
                    const isActive = started && idx === currentIdx && p?.status === 'downloading';

                    return (
                        <div key={asset.asset_id} className="rounded-[10px] border border-outline-variant bg-surface-container p-4 flex flex-col gap-3">
                            <div className="flex items-center gap-3">
                                <StatusIcon status={p?.status ?? 'pending'} isActive={isActive} />
                                <span className="flex-1 font-body-md text-body-md text-on-surface">{asset.label}</span>
                                {p?.status === 'downloading' && p.total_bytes && (
                                    <span className="font-body-sm text-body-sm text-on-surface-variant">
                                        {formatBytes(p.bytes_received)} / {formatBytes(p.total_bytes)}
                                    </span>
                                )}
                                {p?.status === 'extracting' && (
                                    <span className="font-body-sm text-body-sm text-on-surface-variant">Extracting…</span>
                                )}
                                {p?.status === 'done' && (
                                    <span className="font-body-sm text-body-sm text-on-surface-variant">{formatBytes(asset.size_bytes)}</span>
                                )}
                            </div>
                            {(p?.status === 'downloading' || p?.status === 'done') && (
                                <div className="h-1.5 rounded-full bg-surface-container-high overflow-hidden">
                                    <div
                                        className="h-1.5 rounded-full bg-primary transition-all duration-300"
                                        style={{ width: `${p.status === 'done' ? 100 : pct}%` }}
                                    />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function StatusIcon({ status, isActive }: { status: AssetProgress['status']; isActive: boolean }): React.ReactElement {
    if (status === 'done') {
        return (
            <span
                className="material-symbols-outlined text-primary shrink-0"
                style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}
            >
                check_circle
            </span>
        );
    }
    if (status === 'error') {
        return (
            <span className="material-symbols-outlined text-error shrink-0" style={{ fontSize: '20px' }}>error</span>
        );
    }
    if (isActive || status === 'downloading' || status === 'extracting') {
        return (
            <span className="material-symbols-outlined text-primary animate-spin shrink-0" style={{ fontSize: '20px' }}>progress_activity</span>
        );
    }
    return (
        <span className="material-symbols-outlined text-on-surface-variant/40 shrink-0" style={{ fontSize: '20px' }}>radio_button_unchecked</span>
    );
}
