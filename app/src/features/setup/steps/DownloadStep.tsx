import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import ConfirmDialog from '../../../components/ConfirmDialog';
import type { AssetManifestEntry, AssetProgress, SetupConfig } from '../types';

interface Props {
    config: SetupConfig;
    onComplete: () => void;
    onError: (message: string) => void;
    /** Cancel the in-progress install and return to the start. Progress on disk is
     *  preserved, so a later run resumes from where it left off. */
    onCancel: () => void;
}

// Phase comes from the Rust `setup:progress` event; bytes accumulate during
// `downloading`, then a brief `verifying` tick once the rolling hash is confirmed.
interface ProgressEvent {
    asset_id: string;
    phase: 'downloading' | 'verifying';
    bytes_received: number;
    total_bytes: number | null;
}

const TERMINAL: AssetProgress['status'][] = ['done', 'skipped', 'extracting', 'error'];

function formatBytes(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}

// Round time-remaining to a friendly, low-precision phrase — non-technical users
// want "about 5 minutes left", not "4m 37s".
function formatEta(seconds: number): string {
    if (seconds < 60) return 'Less than a minute remaining';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `About ${mins} minute${mins === 1 ? '' : 's'} remaining`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0
        ? `About ${hrs} hour${hrs === 1 ? '' : 's'} remaining`
        : `About ${hrs} h ${rem} min remaining`;
}

// Compact per-item variant, e.g. "~3 min left".
function formatEtaShort(seconds: number): string {
    if (seconds < 60) return 'less than a minute left';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `~${mins} min left`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0 ? `~${hrs} h left` : `~${hrs} h ${rem} min left`;
}

const STATUS_VERB: Partial<Record<AssetProgress['status'], string>> = {
    downloading: 'Downloading',
    verifying: 'Checking',
    extracting: 'Installing',
};

export default function DownloadStep({ config, onComplete, onError, onCancel }: Props): React.ReactElement {
    const [manifest, setManifest] = useState<AssetManifestEntry[]>([]);
    const [progress, setProgress] = useState<Record<string, AssetProgress>>({});
    // null = no dialog; 'cancel' = cancel button (→ back to start); 'quit' = window
    // close (→ exit the app). Both pause the install and keep partial progress.
    const [confirmKind, setConfirmKind] = useState<null | 'cancel' | 'quit'>(null);
    // The per-component list is collapsed by default to keep the screen minimal —
    // the overall bar + total time are the focal point.
    const [showDetails, setShowDetails] = useState(false);
    const didStart = useRef(false);
    const cancelledRef = useRef(false);

    // Signal cancellation to the running loop and to Rust (so a long download stops
    // promptly between chunks rather than running to completion).
    const requestCancel = async () => {
        cancelledRef.current = true;
        try { await invoke('cancel_setup'); } catch { /* best effort */ }
    };

    // Intercept the window's close (X) button while installing: confirm first, so an
    // accidental click doesn't throw away an in-progress download.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let disposed = false;
        getCurrentWindow()
            .onCloseRequested((event) => {
                event.preventDefault();
                setConfirmKind('quit');
            })
            .then((fn) => { if (disposed) fn(); else unlisten = fn; })
            .catch(() => { /* close interception unavailable — fall back to default close */ });
        return () => { disposed = true; unlisten?.(); };
    }, []);

    const handleConfirm = async () => {
        const kind = confirmKind;
        setConfirmKind(null);
        await requestCancel();
        if (kind === 'quit') {
            // Close the app. If destroy is unavailable for any reason, fall back to
            // returning to the start screen rather than leaving the user stuck.
            try {
                await getCurrentWindow().destroy();
            } catch {
                onCancel();
            }
        } else {
            onCancel();
        }
    };

    useEffect(() => {
        if (didStart.current) return;
        didStart.current = true;

        const run = async () => {
            let unlistenFn: (() => void) | undefined;

            try {
                // Fresh run for this component instance. The Rust generation counter
                // is only ever advanced (by cancel), so there's nothing to reset here;
                // this download binds to whatever the current generation is.
                cancelledRef.current = false;

                const entries = await invoke<AssetManifestEntry[]>('get_asset_manifest', {
                    backend: config.backend,
                });
                setManifest(entries);

                const initialProgress: Record<string, AssetProgress> = {};
                entries.forEach(e => {
                    initialProgress[e.asset_id] = e.installed
                        ? { status: 'skipped', bytes_received: e.size_bytes, total_bytes: e.size_bytes }
                        : { status: 'pending', bytes_received: 0, total_bytes: e.size_bytes };
                });
                setProgress(initialProgress);

                // Stream download/verify progress from Rust. Guard against a late
                // event regressing a status that has already moved on (Tauri events
                // and the invoke response arrive on separate channels).
                unlistenFn = await listen<ProgressEvent>('setup:progress', (event) => {
                    const { asset_id, phase, bytes_received, total_bytes } = event.payload;
                    setProgress(prev => {
                        const cur = prev[asset_id];
                        if (cur && TERMINAL.includes(cur.status)) return prev;
                        return {
                            ...prev,
                            [asset_id]: {
                                ...cur,
                                status: phase === 'verifying' ? 'verifying' : 'downloading',
                                bytes_received,
                                total_bytes,
                            },
                        };
                    });
                });

                const setStatus = (id: string, status: AssetProgress['status'], extra?: Partial<AssetProgress>) =>
                    setProgress(prev => ({ ...prev, [id]: { ...prev[id], status, ...extra } }));

                // Downloads run sequentially — they share one network pipe, so racing
                // the multi-GB model against the small binaries wouldn't be faster and
                // would multiply memory/disk contention. Extraction (CPU/disk bound),
                // however, is kicked off without awaiting so it overlaps the *next*
                // asset's download. download_file now verifies the hash inline, so
                // there is no separate verify pass.
                const extractions: Promise<void>[] = [];

                for (const asset of entries) {
                    if (cancelledRef.current) return;
                    if (asset.installed) continue;

                    setStatus(asset.asset_id, 'downloading');
                    try {
                        await invoke('download_file', {
                            url: asset.url_primary,
                            destPath: asset.dest_path,
                            assetId: asset.asset_id,
                            expectedSha256: asset.sha256,
                        });
                    } catch (primaryErr) {
                        if (cancelledRef.current) return; // cancelled, not a real failure
                        if (asset.url_fallback) {
                            // Primary exhausted its retries (or failed verification). The
                            // fallback is a different origin, so discard the partial bytes
                            // before resuming — mixing two sources would corrupt the file.
                            await invoke('clear_partial_download', { destPath: asset.dest_path });
                            await invoke('download_file', {
                                url: asset.url_fallback,
                                destPath: asset.dest_path,
                                assetId: asset.asset_id,
                                expectedSha256: asset.sha256,
                            });
                        } else {
                            throw primaryErr;
                        }
                    }

                    if (asset.extract_to_dir) {
                        setStatus(asset.asset_id, 'extracting');
                        // Don't await: let it unpack while the next download starts.
                        extractions.push(
                            invoke('extract_archive', {
                                archivePath: asset.dest_path,
                                destDir: asset.extract_to_dir,
                                flattenMarker: asset.flatten_marker,
                            }).then(() => setStatus(asset.asset_id, 'done', { bytes_received: asset.size_bytes })),
                        );
                    } else {
                        setStatus(asset.asset_id, 'done', { bytes_received: asset.size_bytes });
                    }
                }

                // Make sure every overlapped extraction finished (and surface any error).
                await Promise.all(extractions);

                if (cancelledRef.current) return;
                onComplete();
            } catch (err) {
                if (cancelledRef.current) return; // cancellation surfaces as a download error — ignore it
                onError(String(err));
            } finally {
                unlistenFn?.();
            }
        };

        run();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Overall progress (byte-weighted so the big model dominates and the bar moves
    // smoothly) plus the byte accounting the time-remaining estimate needs.
    // `remainingBytes`/`receivedBytes` ignore already-installed assets — those aren't
    // downloaded this run, so counting them would skew the throughput estimate.
    const { overallPct, readyCount, receivedBytes, remainingBytes, anyDownloading } = useMemo(() => {
        let total = 0, done = 0, ready = 0;
        let received = 0, remaining = 0, anyDownloading = false;
        for (const asset of manifest) {
            const size = asset.size_bytes;
            total += size;
            const status = progress[asset.asset_id]?.status ?? 'pending';
            const bytes = Math.min(progress[asset.asset_id]?.bytes_received ?? 0, size);

            // Overall bar: already-installed counts as done.
            if (status === 'done' || status === 'skipped') { done += size; ready += 1; }
            else if (status === 'extracting' || status === 'verifying') { done += size; }
            else if (status === 'downloading') { done += bytes; }

            // ETA accounting: exclude already-installed (skipped).
            if (status === 'skipped') continue;
            if (status === 'done' || status === 'verifying' || status === 'extracting') {
                received += size;
            } else if (status === 'downloading') {
                received += bytes;
                remaining += size - bytes;
                anyDownloading = true;
            } else {
                remaining += size; // pending / error — still to download
            }
        }
        return {
            overallPct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
            readyCount: ready,
            receivedBytes: received,
            remainingBytes: remaining,
            anyDownloading,
        };
    }, [manifest, progress]);

    // Real-time throughput for the time-remaining estimates. A 1 s ticker samples
    // cumulative bytes downloaded over a trailing window; smoothing avoids the wild
    // swings a per-chunk rate gives. The same rate drives both the total estimate
    // (top) and the current item's estimate (in the details list).
    const statsRef = useRef({ receivedBytes: 0, anyDownloading: false });
    statsRef.current = { receivedBytes, anyDownloading };
    const [rateBps, setRateBps] = useState<number | null>(null);

    useEffect(() => {
        const samples: { t: number; bytes: number }[] = [];
        const WINDOW_MS = 12_000;
        const id = setInterval(() => {
            const now = Date.now();
            const { receivedBytes, anyDownloading } = statsRef.current;
            samples.push({ t: now, bytes: receivedBytes });
            while (samples.length > 2 && now - samples[0].t > WINDOW_MS) samples.shift();
            if (!anyDownloading || samples.length < 2) return; // keep last known rate

            const first = samples[0];
            const spanMs = now - first.t;
            const deltaBytes = receivedBytes - first.bytes;
            // Need a meaningful window with real progress; a stalled connection (no new
            // bytes) keeps the previous rate rather than reporting an absurd estimate.
            if (spanMs < 2_000 || deltaBytes <= 0) return;
            setRateBps(deltaBytes / (spanMs / 1000));
        }, 1000);
        return () => clearInterval(id);
    }, []);

    const totalEtaSeconds = remainingBytes <= 0
        ? 0
        : rateBps ? Math.max(1, Math.round(remainingBytes / rateBps)) : null;

    const etaText: string | null = manifest.length === 0
        ? null
        : remainingBytes <= 0
            ? (readyCount === manifest.length ? null : 'Finishing up…')
            : totalEtaSeconds == null
                ? 'Estimating time remaining…'
                : formatEta(totalEtaSeconds);

    // A single friendly line describing what's happening right now.
    const statusLine = useMemo(() => {
        if (manifest.length === 0) return 'Preparing…';
        const active = manifest.find(a => {
            const s = progress[a.asset_id]?.status;
            return s === 'downloading' || s === 'verifying' || s === 'extracting';
        });
        if (active) {
            const s = progress[active.asset_id].status;
            return `${STATUS_VERB[s] ?? 'Working on'} ${active.label.replace(/\s*\(.*\)$/, '')}…`;
        }
        if (readyCount === manifest.length) return 'Finishing up…';
        return 'Starting…';
    }, [manifest, progress, readyCount]);

    return (
        <div className="flex flex-col gap-8">
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">Setting things up</h2>
                <p className="font-body-md text-body-md text-on-surface-variant mt-1">
                    Downloading and installing everything Artifact needs. You can cancel any time —
                    your progress is saved, so you can pick up where you left off later.
                </p>
            </div>

            {/* Prominent overall progress — the focal point for non-technical users */}
            <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                    <span className="font-body-md text-body-md text-on-surface">{statusLine}</span>
                    <span className="font-headline-sm text-headline-sm text-primary tabular-nums">{overallPct}%</span>
                </div>
                <div className="h-2.5 rounded-full bg-surface-container-high overflow-hidden">
                    <div
                        className="h-2.5 rounded-full bg-primary transition-all duration-300 ease-out"
                        style={{ width: `${overallPct}%` }}
                    />
                </div>
                {manifest.length > 0 && (
                    <div className="flex items-center justify-between gap-3">
                        <span className="font-body-sm text-body-sm text-on-surface-variant">
                            {readyCount} of {manifest.length} components ready
                        </span>
                        {etaText && (
                            <span className="flex items-center gap-1.5 font-body-md text-body-md text-on-surface">
                                <span className="material-symbols-outlined" style={{ fontSize: '18px' }} aria-hidden="true">schedule</span>
                                {etaText}
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* Collapsible per-component detail — closed by default to keep things minimal */}
            {manifest.length === 0 ? (
                <div className="flex items-center gap-3 text-on-surface-variant font-body-md text-body-md">
                    <span className="material-symbols-outlined animate-spin" style={{ fontSize: '20px' }}>progress_activity</span>
                    Preparing download list…
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    <button
                        type="button"
                        onClick={() => setShowDetails(v => !v)}
                        className="flex items-center gap-1 self-start font-label-md text-label-md text-on-surface-variant hover:text-on-surface transition-colors"
                        aria-expanded={showDetails}
                    >
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }} aria-hidden="true">
                            {showDetails ? 'expand_less' : 'expand_more'}
                        </span>
                        {showDetails ? 'Hide details' : 'Show details'}
                    </button>

                    {showDetails && (
                        <div className="flex flex-col gap-3">
                            {manifest.map((asset) => {
                                const p = progress[asset.asset_id];
                                const status = p?.status ?? 'pending';
                                const pct = p && p.total_bytes
                                    ? Math.min(100, Math.round((p.bytes_received / p.total_bytes) * 100))
                                    : 0;
                                const showBar = status === 'downloading' || status === 'done' || status === 'skipped';
                                // Per-item time remaining for the asset currently downloading.
                                const itemRemaining = (p?.total_bytes ?? 0) - (p?.bytes_received ?? 0);
                                const itemEta = status === 'downloading' && rateBps && itemRemaining > 0
                                    ? Math.max(1, Math.round(itemRemaining / rateBps))
                                    : null;

                                return (
                                    <div key={asset.asset_id} className="rounded-[10px] border border-outline-variant bg-surface-container p-4 flex flex-col gap-3">
                                        <div className="flex items-center gap-3">
                                            <StatusIcon status={status} />
                                            <span className="flex-1 font-body-md text-body-md text-on-surface">{asset.label}</span>
                                            {status === 'downloading' && p?.total_bytes && (
                                                <div className="flex flex-col items-end leading-tight">
                                                    <span className="font-body-sm text-body-sm text-on-surface-variant tabular-nums">
                                                        {formatBytes(p.bytes_received)} / {formatBytes(p.total_bytes)}
                                                    </span>
                                                    <span className="font-body-sm text-xs text-on-surface-variant/70 tabular-nums">
                                                        {itemEta != null ? formatEtaShort(itemEta) : 'estimating…'}
                                                    </span>
                                                </div>
                                            )}
                                            {status === 'verifying' && (
                                                <span className="font-body-sm text-body-sm text-on-surface-variant">Verifying…</span>
                                            )}
                                            {status === 'extracting' && (
                                                <span className="font-body-sm text-body-sm text-on-surface-variant">Installing…</span>
                                            )}
                                            {status === 'done' && (
                                                <span className="font-body-sm text-body-sm text-on-surface-variant">{formatBytes(asset.size_bytes)}</span>
                                            )}
                                            {status === 'skipped' && (
                                                <span className="font-body-sm text-body-sm text-on-surface-variant">Already installed</span>
                                            )}
                                        </div>
                                        {showBar && (
                                            <div className="h-1.5 rounded-full bg-surface-container-high overflow-hidden">
                                                <div
                                                    className="h-1.5 rounded-full bg-primary transition-all duration-300"
                                                    style={{ width: `${status === 'downloading' ? pct : 100}%` }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Cancel is always available; progress is preserved for next time. */}
            <div className="flex justify-center">
                <button
                    type="button"
                    onClick={() => setConfirmKind('cancel')}
                    className="font-label-md text-label-md text-on-surface-variant hover:text-on-surface underline-offset-2 hover:underline transition-colors"
                >
                    Cancel setup
                </button>
            </div>

            <ConfirmDialog
                open={confirmKind !== null}
                title={confirmKind === 'quit' ? 'Quit setup?' : 'Cancel setup?'}
                description="Your progress is saved. The next time you open Artifact, setup will pick up right where it left off."
                confirmLabel={confirmKind === 'quit' ? 'Quit' : 'Cancel setup'}
                cancelLabel="Keep going"
                onConfirm={handleConfirm}
                onCancel={() => setConfirmKind(null)}
            />
        </div>
    );
}

function StatusIcon({ status }: { status: AssetProgress['status'] }): React.ReactElement {
    if (status === 'done' || status === 'skipped') {
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
    if (status === 'downloading' || status === 'verifying' || status === 'extracting') {
        return (
            <span className="material-symbols-outlined text-primary animate-spin shrink-0" style={{ fontSize: '20px' }}>progress_activity</span>
        );
    }
    return (
        <span className="material-symbols-outlined text-on-surface-variant/40 shrink-0" style={{ fontSize: '20px' }}>radio_button_unchecked</span>
    );
}
