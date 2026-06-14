import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { HardwareInfo } from '../types';
import { BACKEND_LABEL } from '../backend';

interface Props {
    onAutomatic: (hardware: HardwareInfo) => void;
    onCustom: (hardware: HardwareInfo) => void;
}

const ASSETS = [
    { icon: 'smart_toy',    label: 'Qwen language model',   size: '2.7 GB' },
    { icon: 'visibility',   label: 'Vision projector',      size: '656 MB' },
    { icon: 'memory',       label: 'llama-server binary',   size: '~46–80 MB' },
];

function summarize(hw: HardwareInfo): string {
    const build = BACKEND_LABEL[hw.recommended_backend];
    if (hw.recommended_backend === 'cpu' || !hw.gpu_name) {
        return `No compatible GPU detected — Artifact will install the ${build} build.`;
    }
    const vram = hw.vram_mb != null ? ` (${(hw.vram_mb / 1024).toFixed(1)} GB)` : '';
    return `Detected ${hw.gpu_name}${vram} — Artifact will install the ${build} build.`;
}

export default function WelcomeStep({ onAutomatic, onCustom }: Props): React.ReactElement {
    const [hw, setHw] = useState<HardwareInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Probe hardware as soon as the wizard opens so the Automatic button is a
    // genuine single click — by the time the user reads the screen, the
    // recommendation is ready and no further input is needed.
    useEffect(() => {
        invoke<HardwareInfo>('detect_hardware')
            .then(setHw)
            .catch(e => setError(String(e)));
    }, []);

    const ready = hw != null;

    return (
        <div className="flex flex-col gap-8">
            <div>
                <h1 className="font-display-lg text-display-lg text-primary tracking-tight">
                    Welcome to Artifact
                </h1>
                <p className="font-body-lg text-body-lg text-on-surface-variant mt-3 max-w-xl">
                    Before you can start extracting data, the app needs to download a few
                    large components. This only happens once and takes about 10–15 minutes
                    depending on your connection.
                </p>
            </div>

            <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                {ASSETS.map(({ icon, label, size }) => (
                    <div key={label} className="flex items-center gap-4 px-5 py-4">
                        <span
                            className="material-symbols-outlined text-primary shrink-0"
                            style={{ fontSize: '20px' }}
                        >
                            {icon}
                        </span>
                        <span className="flex-1 font-body-md text-body-md text-on-surface">{label}</span>
                        <span className="font-body-sm text-body-sm text-on-surface-variant">{size}</span>
                    </div>
                ))}
            </div>

            {/* Hardware status line — drives what Automatic will install */}
            <div className="flex items-center gap-2.5 min-h-5 font-body-sm text-body-sm text-on-surface-variant">
                {!ready && !error && (
                    <>
                        <span className="material-symbols-outlined animate-spin" style={{ fontSize: '18px' }}>progress_activity</span>
                        Detecting your hardware…
                    </>
                )}
                {error && (
                    <>
                        <span className="material-symbols-outlined text-error" style={{ fontSize: '18px' }}>error</span>
                        Couldn’t detect hardware. You can still choose a backend under Custom setup.
                    </>
                )}
                {ready && (
                    <>
                        <span className="material-symbols-outlined text-primary" style={{ fontSize: '18px' }}>verified</span>
                        {summarize(hw)}
                    </>
                )}
            </div>

            {/* Two clear paths: one-click Automatic vs. hands-on Custom */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                    type="button"
                    disabled={!ready}
                    onClick={() => hw && onAutomatic(hw)}
                    className="text-left rounded-[10px] border-2 border-primary bg-primary/5 p-5 flex flex-col gap-2 hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary" style={{ fontSize: '22px' }}>bolt</span>
                        <span className="font-label-lg text-label-lg text-on-surface">Automatic</span>
                        <span className="px-2 py-0.5 rounded-full bg-primary/15 font-label-sm text-label-sm text-primary">Recommended</span>
                    </div>
                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                        One click. Downloads everything and picks the build matched to your hardware.
                    </p>
                </button>

                <button
                    type="button"
                    disabled={!ready && !error}
                    onClick={() => hw && onCustom(hw)}
                    className="text-left rounded-[10px] border border-outline-variant bg-surface-container p-5 flex flex-col gap-2 hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: '22px' }}>tune</span>
                        <span className="font-label-lg text-label-lg text-on-surface">Custom</span>
                    </div>
                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                        Review your hardware and choose which backend to install yourself.
                    </p>
                </button>
            </div>

            <p className="font-body-sm text-body-sm text-on-surface-variant">
                All files are downloaded from Cloudflare R2 (primary) with HuggingFace as a
                fallback for model files. Nothing is sent from your machine — downloads are
                one-way.
            </p>
        </div>
    );
}
