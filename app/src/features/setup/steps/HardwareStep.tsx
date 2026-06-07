import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { HardwareInfo } from '../types';

interface Props {
    onNext: (info: HardwareInfo) => void;
    onBack: () => void;
}

function formatMb(mb: number): string {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export default function HardwareStep({ onNext, onBack }: Props): React.ReactElement {
    const [info, setInfo] = useState<HardwareInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        invoke<HardwareInfo>('detect_hardware')
            .then(setInfo)
            .catch(e => setError(String(e)));
    }, []);

    const backendLabel: Record<string, string> = {
        cuda:  'CUDA (NVIDIA GPU)',
        rocm:  'ROCm (AMD GPU)',
        metal: 'Metal (Apple Silicon)',
        cpu:   'CPU only',
    };

    return (
        <div className="flex flex-col gap-8">
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">Hardware detection</h2>
                <p className="font-body-md text-body-md text-on-surface-variant mt-1">
                    Artifact detected your system configuration and picked the best components
                    to download. You can change this on the next screen.
                </p>
            </div>

            {!info && !error && (
                <div className="flex items-center gap-3 text-on-surface-variant font-body-md text-body-md">
                    <span className="material-symbols-outlined animate-spin" style={{ fontSize: '20px' }}>progress_activity</span>
                    Scanning hardware…
                </div>
            )}

            {error && (
                <div className="rounded-[10px] border border-error/30 bg-error/5 px-5 py-4 flex items-start gap-3">
                    <span className="material-symbols-outlined text-error shrink-0" style={{ fontSize: '20px' }}>error</span>
                    <p className="font-body-md text-body-md text-error">{error}</p>
                </div>
            )}

            {info && (
                <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                    <Row icon="memory" label="RAM" value={formatMb(info.ram_mb)} />
                    <Row
                        icon="display_settings"
                        label="GPU"
                        value={info.gpu_name ?? 'None detected'}
                    />
                    {info.vram_mb != null && (
                        <Row icon="developer_board" label="VRAM" value={formatMb(info.vram_mb)} />
                    )}
                    <Row
                        icon="rocket_launch"
                        label="Recommended backend"
                        value={backendLabel[info.recommended_backend] ?? info.recommended_backend}
                        highlight
                    />
                </div>
            )}

            <div className="flex justify-between">
                <button
                    type="button"
                    onClick={onBack}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-outline-variant bg-surface-container hover:bg-surface-container-high font-label-md text-label-md text-on-surface-variant transition-colors"
                >
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>arrow_back</span>
                    Back
                </button>
                <button
                    type="button"
                    disabled={!info}
                    onClick={() => info && onNext(info)}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    Continue
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>arrow_forward</span>
                </button>
            </div>
        </div>
    );
}

function Row({ icon, label, value, highlight = false }: {
    icon: string; label: string; value: string; highlight?: boolean;
}): React.ReactElement {
    return (
        <div className="flex items-center gap-4 px-5 py-4">
            <span
                className={`material-symbols-outlined shrink-0 ${highlight ? 'text-primary' : 'text-on-surface-variant'}`}
                style={{ fontSize: '20px' }}
            >
                {icon}
            </span>
            <span className="flex-1 font-body-md text-body-md text-on-surface-variant">{label}</span>
            <span className={`font-body-md text-body-md ${highlight ? 'text-primary font-medium' : 'text-on-surface'}`}>{value}</span>
        </div>
    );
}
