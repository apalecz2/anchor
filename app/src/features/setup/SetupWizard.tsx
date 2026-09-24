import React, { useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import type { ConsentContext, HardwareInfo, SetupConfig, SetupMode, SetupStep } from './types';
import { setBackHandler } from '../../lib/navState';
import { acceptedEulaVersion } from '../legal/eulaAcceptance';
import { listPipelinePresets, type PresetOption } from '../settings/pipelinePresets';
import WelcomeStep from './steps/WelcomeStep';
import TermsStep from './steps/TermsStep';
import ConfigStep from './steps/ConfigStep';
import DownloadStep from './steps/DownloadStep';
import CompleteStep from './steps/CompleteStep';

interface Props {
    /** False when the user has not accepted the current EULA version, which adds the
     *  Terms step to the run. Owned by App so it can gate the app itself. */
    eulaAccepted: boolean;
    /** Records acceptance (version + timestamp). */
    onAcceptEula: () => void;
    /** False when the assets are already installed and this run exists only to
     *  collect consent for a bumped EULA — then Terms is the whole wizard. */
    installNeeded: boolean;
    /** Set only when the wizard can be walked away from: a re-run the user asked
     *  for, over an install that is already fine. Undefined for a first install and
     *  for a consent run, which have to be finished. Drives the window's Back
     *  button, which is what a user who changed their mind reaches for. */
    onExit?: () => void;
    onComplete: () => void;
}

const STEP_LABELS: Record<SetupStep, string> = {
    welcome:  'Welcome',
    terms:    'Terms',
    config:   'Configure',
    install:  'Install',
    complete: 'Complete',
};

// The consent gate is a step of this wizard rather than a separate screen, so the
// user sees one numbered list from launch to launch — but it must stay *ahead* of
// `install`, since acceptance is required before anything is downloaded or run.
// Automatic setup skips Configure, and an already-accepted EULA skips Terms, so the
// progress bar reflects whichever path this run actually takes. Download + verify +
// install are a single step (the hash is checked during the download, so there's no
// separate pass).
/** Steps a re-run may simply be walked away from, having done nothing yet. */
const EXITABLE_STEPS: SetupStep[] = ['welcome', 'terms', 'config'];

function stepsFor(mode: SetupMode, needsEula: boolean, needsInstall: boolean): SetupStep[] {
    if (!needsInstall) return ['terms'];
    const steps: SetupStep[] = ['welcome'];
    if (needsEula) steps.push('terms');
    if (mode === 'custom') steps.push('config');
    return [...steps, 'install', 'complete'];
}

export default function SetupWizard({ eulaAccepted, onAcceptEula, installNeeded, onExit, onComplete }: Props): React.ReactElement {
    // Both are frozen at mount: accepting the EULA flips `eulaAccepted` mid-run, and
    // recomputing from it would drop the Terms pill out of the progress bar while the
    // user is still walking the list.
    const [needsEula] = useState(!eulaAccepted);
    const [needsInstall] = useState(installNeeded);
    // Also frozen: accepting rewrites the stored version, and this decides the consent
    // step's copy. Only a run that still has to install may promise that nothing has
    // been downloaded yet — after an EULA bump the assets are already on disk.
    const [priorEulaVersion] = useState(acceptedEulaVersion);
    const consentContext: ConsentContext = needsInstall
        ? 'first-install'
        : priorEulaVersion ? 'terms-updated' : 'reconsent';

    const [step, setStep] = useState<SetupStep>(needsInstall ? 'welcome' : 'terms');
    const [mode, setMode] = useState<SetupMode>('automatic');
    const [hardware, setHardware] = useState<HardwareInfo | null>(null);
    const [config, setConfig] = useState<SetupConfig | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const stepOrder = stepsFor(mode, needsEula, needsInstall);
    const currentIdx = stepOrder.indexOf(step);

    // Whether leaving is on offer right now — drives both the button below and the
    // window's Back button, so the two can't disagree.
    //
    // Only on the steps that are still just *asking*, where walking away costs
    // nothing: `install` owns its own cancellation, because a download in flight
    // has to be stopped and confirmed rather than abandoned behind a closing screen
    // (its *Cancel setup* lands back on Welcome), and `complete` still has work to
    // do — its Launch button is what persists the new paths and reloads into them.
    // A *failed* install is offered again regardless of step: nothing is running,
    // and a re-run that got nowhere leaves the install it started from untouched,
    // so "Start over" shouldn't be the only way out.
    const exit = onExit && (errorMsg !== null || EXITABLE_STEPS.includes(step)) ? onExit : null;

    // Give the window's Back button a meaning while this screen is up, since the
    // routes it would otherwise move through aren't mounted. See lib/navState.ts.
    useEffect(() => {
        if (!exit) return;
        setBackHandler(exit);
        return () => setBackHandler(null);
    }, [exit]);

    const handleError = (msg: string) => setErrorMsg(msg);

    // One-click automatic path: take the hardware-recommended backend and jump
    // straight to consent + downloading, skipping the Configure step entirely.
    const startAutomatic = (info: HardwareInfo) => {
        setHardware(info);
        setMode('automatic');
        setConfig({ backend: info.recommended_backend, presetId: info.recommended_preset });
        setStep(needsEula ? 'terms' : 'install');
    };

    const startCustom = (info: HardwareInfo) => {
        setHardware(info);
        setMode('custom');
        setStep(needsEula ? 'terms' : 'config');
    };

    const acceptTerms = () => {
        onAcceptEula();
        // Consent-only run: App drops the wizard as soon as acceptance is recorded.
        if (needsInstall) setStep(mode === 'custom' ? 'config' : 'install');
    };

    // Escape hatch for a persisted preset whose assets can't download (dead URL,
    // network issue, or one that never finished installing before). Re-entering
    // `install` with a different presetId makes DownloadStep persist *that* id
    // before fetching its manifest, overwriting whatever broken value was on disk —
    // an already-installed preset then completes immediately with no downloads.
    const retryWithPreset = (id: string) => {
        setErrorMsg(null);
        setConfig(cfg => (cfg ? { ...cfg, presetId: id } : cfg));
        setStep('install');
    };

    return (
        <div className="h-full bg-surface flex flex-col">
            {/* Step progress bar — pointless when consent is the only step */}
            {stepOrder.length > 1 && (
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
                                            ? <Icon name="check" size={14} />
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
            )}

            {/* Step content */}
            <div className="flex-1 overflow-y-auto flex items-start justify-center p-8">
                <div className="w-full max-w-2xl">
                    {/* The way out of a re-run, for a user who has changed their mind.
                        Quiet and above the step's own Back (which walks the wizard's
                        list), because leaving entirely is the rarer of the two. */}
                    {exit && (
                        <button
                            type="button"
                            onClick={exit}
                            className="-ml-2 mb-6 flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                        >
                            <Icon name="arrow_back" size={18} />
                            Back to Anchor
                        </button>
                    )}

                    {errorMsg ? (
                        <ErrorView
                            message={errorMsg}
                            onRetry={() => { setErrorMsg(null); setStep('welcome'); }}
                            onChoosePreset={retryWithPreset}
                        />
                    ) : (
                        <>
                            {step === 'welcome' && (
                                <WelcomeStep onAutomatic={startAutomatic} onCustom={startCustom} />
                            )}
                            {step === 'terms' && (
                                <TermsStep
                                    context={consentContext}
                                    onAccept={acceptTerms}
                                    onBack={needsInstall ? () => setStep('welcome') : undefined}
                                />
                            )}
                            {step === 'config' && hardware && (
                                <ConfigStep
                                    hardware={hardware}
                                    onNext={cfg => { setConfig(cfg); setStep('install'); }}
                                    onBack={() => setStep('welcome')}
                                />
                            )}
                            {step === 'install' && config && (
                                <DownloadStep
                                    config={config}
                                    onComplete={() => setStep('complete')}
                                    onError={handleError}
                                    onCancel={() => setStep('welcome')}
                                />
                            )}
                            {step === 'complete' && config && (
                                <CompleteStep backend={config.backend} presetId={config.presetId} onLaunch={onComplete} />
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function ErrorView({
    message,
    onRetry,
    onChoosePreset,
}: {
    message: string;
    onRetry: () => void;
    /** Lets the user pick a different pipeline preset right from the failure screen,
     *  instead of only "Start over" — which alone never fixes a persisted preset
     *  whose assets can't download, since a fresh automatic run just re-selects the
     *  same recommended preset and fails again. */
    onChoosePreset: (id: string) => void;
}): React.ReactElement {
    const [presets, setPresets] = useState<PresetOption[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        listPipelinePresets()
            .then(rows => { if (!cancelled) setPresets(rows); })
            .catch(() => { if (!cancelled) setPresets([]); });
        return () => { cancelled = true; };
    }, []);

    return (
        <div className="flex flex-col gap-6 items-center text-center py-8">
            <Icon name="error" size={48} className="text-error" />
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">Setup failed</h2>
                <p className="font-body-md text-body-md text-on-surface-variant mt-2 max-w-md">{message}</p>
            </div>
            <button
                type="button"
                onClick={onRetry}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary/90 transition-colors"
            >
                <Icon name="refresh" size={18} />
                Start over
            </button>

            {presets && presets.length > 1 && (
                <div className="w-full max-w-md text-left mt-2">
                    <p className="font-body-sm text-body-sm text-on-surface-variant mb-2">
                        Or try a different pipeline — useful if the one above keeps failing to
                        download:
                    </p>
                    <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                        {presets.map(preset => (
                            <button
                                key={preset.id}
                                type="button"
                                onClick={() => onChoosePreset(preset.id)}
                                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-on-surface/[0.03] transition-colors"
                            >
                                <Icon
                                    name={preset.installed ? 'check_circle' : 'download'}
                                    size={18}
                                    className={`shrink-0 ${preset.installed ? 'text-primary' : 'text-on-surface-variant'}`}
                                />
                                <span className="flex-1 min-w-0">
                                    <span className="font-body-md text-body-md text-on-surface block">{preset.label}</span>
                                    <span className="font-body-sm text-body-sm text-on-surface-variant">
                                        {preset.installed ? 'Already installed — no download needed' : `${(preset.download_mb / 1000).toFixed(1)} GB to download`}
                                    </span>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
