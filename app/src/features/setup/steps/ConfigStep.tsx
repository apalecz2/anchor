import React, { useState } from 'react';
import type { Backend, HardwareInfo, SetupConfig } from '../types';
import { BACKEND_DESCRIPTION, BACKEND_LABEL, backendWarning } from '../backend';

interface Props {
    hardware: HardwareInfo;
    onNext: (config: SetupConfig) => void;
    onBack: () => void;
}

function formatMb(mb: number): string {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export default function ConfigStep({ hardware, onNext, onBack }: Props): React.ReactElement {
    // Only offer backends that actually ship an asset for this platform, and never
    // start with a selection that isn't on offer (e.g. a "cpu" recommendation on
    // macOS, which only ships the Metal build).
    const options = hardware.available_backends;
    const [backend, setBackend] = useState<Backend>(
        options.includes(hardware.recommended_backend) ? hardware.recommended_backend : options[0]
    );

    const selectedWarning = backendWarning(backend, hardware);

    return (
        <div className="flex flex-col gap-8">
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">Custom setup</h2>
                <p className="font-body-md text-body-md text-on-surface-variant mt-1">
                    Pick which llama-server build to download. The option matched to your
                    hardware is pre-selected — you can change it, and switch later by
                    re-running setup if needed.
                </p>
            </div>

            {/* Detected hardware (folded in from the old hardware step) */}
            <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                <InfoRow icon="memory" label="RAM" value={formatMb(hardware.ram_mb)} />
                <InfoRow icon="display_settings" label="GPU" value={hardware.gpu_name ?? 'None detected'} />
                {hardware.vram_mb != null && (
                    <InfoRow icon="developer_board" label="VRAM" value={formatMb(hardware.vram_mb)} />
                )}
            </div>

            <div className="flex flex-col gap-3">
                {options.map((value) => {
                    const isRecommended = value === hardware.recommended_backend;
                    const isSelected = value === backend;
                    const warning = backendWarning(value, hardware);
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
                                    <span className="font-label-lg text-label-lg text-on-surface">{BACKEND_LABEL[value]}</span>
                                    {isRecommended && (
                                        <span className="px-2 py-0.5 rounded-full bg-primary/10 font-label-sm text-label-sm text-primary">
                                            Recommended
                                        </span>
                                    )}
                                    {warning && !isRecommended && (
                                        <span className="px-2 py-0.5 rounded-full bg-error/10 font-label-sm text-label-sm text-error">
                                            Not ideal for your hardware
                                        </span>
                                    )}
                                </div>
                                <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{BACKEND_DESCRIPTION[value]}</p>
                            </div>
                        </button>
                    );
                })}
            </div>

            {/* Warn — but don't block — when the selected build doesn't suit the GPU */}
            {selectedWarning && (
                <div className="rounded-[10px] border border-error/30 bg-error/5 px-5 py-4 flex items-start gap-3">
                    <span className="material-symbols-outlined text-error shrink-0" style={{ fontSize: '20px' }}>warning</span>
                    <div className="flex flex-col gap-1">
                        <p className="font-body-md text-body-md text-on-surface">{selectedWarning}</p>
                        <p className="font-body-sm text-body-sm text-on-surface-variant">
                            You can still install it — this isn’t permanent, and you can re-run
                            setup later to download a different build.
                        </p>
                    </div>
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

function InfoRow({ icon, label, value }: { icon: string; label: string; value: string }): React.ReactElement {
    return (
        <div className="flex items-center gap-4 px-5 py-4">
            <span className="material-symbols-outlined text-on-surface-variant shrink-0" style={{ fontSize: '20px' }}>
                {icon}
            </span>
            <span className="flex-1 font-body-md text-body-md text-on-surface-variant">{label}</span>
            <span className="font-body-md text-body-md text-on-surface">{value}</span>
        </div>
    );
}
