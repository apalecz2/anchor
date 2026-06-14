import React, { useState } from 'react';
import type { AssetManifestEntry, HardwareInfo, SetupConfig, SetupMode, SetupStep } from './types';
import WelcomeStep from './steps/WelcomeStep';
import ConfigStep from './steps/ConfigStep';
import DownloadStep from './steps/DownloadStep';
import VerifyStep from './steps/VerifyStep';
import CompleteStep from './steps/CompleteStep';

interface Props {
    onComplete: () => void;
}

const STEP_LABELS: Record<SetupStep, string> = {
    welcome:  'Welcome',
    config:   'Configure',
    download: 'Download',
    verify:   'Verify',
    complete: 'Complete',
};

// Automatic setup skips the Configure step — the progress bar reflects whichever
// path the user picked on the welcome screen.
function stepsForMode(mode: SetupMode): SetupStep[] {
    return mode === 'custom'
        ? ['welcome', 'config', 'download', 'verify', 'complete']
        : ['welcome', 'download', 'verify', 'complete'];
}

export default function SetupWizard({ onComplete }: Props): React.ReactElement {
    const [step, setStep] = useState<SetupStep>('welcome');
    const [mode, setMode] = useState<SetupMode>('automatic');
    const [hardware, setHardware] = useState<HardwareInfo | null>(null);
    const [config, setConfig] = useState<SetupConfig | null>(null);
    const [manifest, setManifest] = useState<AssetManifestEntry[]>([]);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const stepOrder = stepsForMode(mode);
    const currentIdx = stepOrder.indexOf(step);

    const handleError = (msg: string) => setErrorMsg(msg);

    // One-click automatic path: take the hardware-recommended backend and jump
    // straight to downloading, skipping the Configure step entirely.
    const startAutomatic = (info: HardwareInfo) => {
        setHardware(info);
        setMode('automatic');
        setConfig({ backend: info.recommended_backend });
        setStep('download');
    };

    const startCustom = (info: HardwareInfo) => {
        setHardware(info);
        setMode('custom');
        setStep('config');
    };

    return (
        <div className="h-screen bg-surface flex flex-col">
            {/* Step progress bar */}
            <div className="border-b border-outline-variant bg-surface-container px-8 py-4">
                <div className="max-w-2xl mx-auto flex items-center gap-2">
                    {stepOrder.map((s, idx) => {
                        const done = idx < currentIdx;
                        const active = idx === currentIdx;
                        return (
                            <React.Fragment key={s}>
                                {idx > 0 && (
                                    <div className={`flex-1 h-px ${done ? 'bg-primary' : 'bg-outline-variant'}`} />
                                )}
                                <div className="flex flex-col items-center gap-1 shrink-0">
                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors ${
                                        done  ? 'bg-primary text-on-primary' :
                                        active? 'bg-primary/15 border-2 border-primary text-primary' :
                                                'bg-surface-container-high text-on-surface-variant'
                                    }`}>
                                        {done
                                            ? <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check</span>
                                            : idx + 1
                                        }
                                    </div>
                                    <span className={`font-label-sm text-label-sm ${active ? 'text-primary' : 'text-on-surface-variant'}`}>
                                        {STEP_LABELS[s]}
                                    </span>
                                </div>
                            </React.Fragment>
                        );
                    })}
                </div>
            </div>

            {/* Step content */}
            <div className="flex-1 overflow-y-auto flex items-start justify-center p-8">
                <div className="w-full max-w-2xl">
                    {errorMsg ? (
                        <ErrorView message={errorMsg} onRetry={() => { setErrorMsg(null); setStep('welcome'); }} />
                    ) : (
                        <>
                            {step === 'welcome' && (
                                <WelcomeStep onAutomatic={startAutomatic} onCustom={startCustom} />
                            )}
                            {step === 'config' && hardware && (
                                <ConfigStep
                                    hardware={hardware}
                                    onNext={cfg => { setConfig(cfg); setStep('download'); }}
                                    onBack={() => setStep('welcome')}
                                />
                            )}
                            {step === 'download' && config && (
                                <DownloadStep
                                    config={config}
                                    onComplete={entries => { setManifest(entries); setStep('verify'); }}
                                    onError={handleError}
                                />
                            )}
                            {step === 'verify' && (
                                <VerifyStep
                                    manifest={manifest}
                                    onComplete={() => setStep('complete')}
                                    onError={handleError}
                                />
                            )}
                            {step === 'complete' && config && (
                                <CompleteStep backend={config.backend} onLaunch={onComplete} />
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }): React.ReactElement {
    return (
        <div className="flex flex-col gap-6 items-center text-center py-8">
            <span className="material-symbols-outlined text-error" style={{ fontSize: '48px' }}>error</span>
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">Setup failed</h2>
                <p className="font-body-md text-body-md text-on-surface-variant mt-2 max-w-md">{message}</p>
            </div>
            <button
                type="button"
                onClick={onRetry}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary/90 transition-colors"
            >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>refresh</span>
                Start over
            </button>
        </div>
    );
}
