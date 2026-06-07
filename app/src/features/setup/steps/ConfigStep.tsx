import React, { useState } from 'react';
import type { Backend, HardwareInfo, SetupConfig } from '../types';

interface Props {
    hardware: HardwareInfo;
    onNext: (config: SetupConfig) => void;
    onBack: () => void;
}

const BACKEND_OPTIONS: { value: Backend; label: string; description: string; platforms: string[] }[] = [
    {
        value: 'cuda',
        label: 'CUDA',
        description: 'NVIDIA GPU acceleration. Requires a CUDA-capable GPU with 4 GB+ VRAM.',
        platforms: ['windows', 'linux'],
    },
    {
        value: 'rocm',
        label: 'ROCm',
        description: 'AMD GPU acceleration on Linux.',
        platforms: ['linux'],
    },
    {
        value: 'metal',
        label: 'Metal',
        description: 'Apple Silicon GPU acceleration. Only available on macOS.',
        platforms: ['macos'],
    },
    {
        value: 'cpu',
        label: 'CPU only',
        description: 'Works on any machine. Slower but requires no GPU.',
        platforms: ['windows', 'linux', 'macos'],
    },
];

export default function ConfigStep({ hardware, onNext, onBack }: Props): React.ReactElement {
    const [backend, setBackend] = useState<Backend>(hardware.recommended_backend);

    return (
        <div className="flex flex-col gap-8">
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">Configuration</h2>
                <p className="font-body-md text-body-md text-on-surface-variant mt-1">
                    Choose which llama-server build to download. The recommended option is
                    pre-selected based on your hardware.
                </p>
            </div>

            <div className="flex flex-col gap-3">
                {BACKEND_OPTIONS.map(({ value, label, description }) => {
                    const isRecommended = value === hardware.recommended_backend;
                    const isSelected = value === backend;
                    return (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setBackend(value)}
                            className={`text-left rounded-[10px] border p-4 flex items-start gap-4 transition-colors ${
                                isSelected
                                    ? 'border-primary bg-primary/5'
                                    : 'border-outline-variant bg-surface-container hover:bg-surface-container-high'
                            }`}
                        >
                            <div
                                className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                                    isSelected ? 'border-primary' : 'border-outline'
                                }`}
                            >
                                {isSelected && <div className="w-2 h-2 rounded-full bg-primary" />}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-label-lg text-label-lg text-on-surface">{label}</span>
                                    {isRecommended && (
                                        <span className="px-2 py-0.5 rounded-full bg-primary/10 font-label-sm text-label-sm text-primary">
                                            Recommended
                                        </span>
                                    )}
                                </div>
                                <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{description}</p>
                            </div>
                        </button>
                    );
                })}
            </div>

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
                    onClick={() => onNext({ backend })}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary/90 transition-colors"
                >
                    Start download
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>download</span>
                </button>
            </div>
        </div>
    );
}
