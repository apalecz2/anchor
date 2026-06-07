import React from 'react';

interface Props {
    onNext: () => void;
}

const ASSETS = [
    { icon: 'smart_toy',    label: 'Qwen language model',   size: '2.7 GB' },
    { icon: 'visibility',   label: 'Vision projector',      size: '656 MB' },
    { icon: 'memory',       label: 'llama-server binary',   size: '~46–80 MB' },
];

export default function WelcomeStep({ onNext }: Props): React.ReactElement {
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

            <p className="font-body-sm text-body-sm text-on-surface-variant">
                All files are downloaded from Cloudflare R2 (primary) with HuggingFace as a
                fallback for model files. Nothing is sent from your machine — downloads are
                one-way.
            </p>

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={onNext}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary/90 transition-colors"
                >
                    Get started
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>arrow_forward</span>
                </button>
            </div>
        </div>
    );
}
