import React, { useState } from 'react';
import { readSetting, writeSetting, type HardwareMode, type Theme } from '../lib/settings';

function Section({ title, description, children }: {
    title: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <section className="flex flex-col gap-4">
            <div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface">{title}</h2>
                {description && (
                    <p className="font-body-md text-body-md text-on-surface-variant mt-1 max-w-2xl">{description}</p>
                )}
            </div>
            {children}
        </section>
    );
}

function SettingRow({ label, description, children }: {
    label: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-8 px-5 py-4">
            <div className="min-w-0 flex-1">
                <p className="font-body-md text-body-md text-on-surface font-medium">{label}</p>
                {description && (
                    <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{description}</p>
                )}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

function PathField({ label, hint, value, onChange, onBrowse, disabled = false }: {
    label: string;
    hint?: string;
    value: string;
    onChange: (v: string) => void;
    onBrowse: () => void;
    disabled?: boolean;
}) {
    return (
        <div className={`flex flex-col gap-1.5 transition-opacity ${disabled ? 'opacity-40 pointer-events-none select-none' : ''}`}>
            <label className="font-label-md text-label-md text-on-surface">{label}</label>
            {hint && <p className="font-body-sm text-body-sm text-on-surface-variant -mt-0.5">{hint}</p>}
            <div className="flex gap-2 mt-0.5">
                <input
                    type="text"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="Leave blank to use bundled default"
                    disabled={disabled}
                    className="flex-1 rounded-lg border border-outline-variant bg-surface px-3 py-2 font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
                />
                <button
                    type="button"
                    onClick={onBrowse}
                    disabled={disabled}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-outline-variant bg-surface-container hover:bg-surface-container-high font-label-md text-label-md text-on-surface-variant transition-colors"
                >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>folder_open</span>
                    Browse
                </button>
            </div>
        </div>
    );
}

const HARDWARE_OPTIONS: { value: HardwareMode; label: string; heading: string; body: string }[] = [
    {
        value: 'low-end',
        label: 'Low-end mode',
        heading: '8 GB RAM minimum',
        body: 'Vision models are disabled. A lightweight ~2B LLM handles formatting and cleanup, paired with Tesseract for text extraction.',
    },
    {
        value: 'high-end',
        label: 'High-end mode',
        heading: 'Full pipeline',
        body: 'Full vision models with larger context windows for complex tables, mixed layouts, and handwritten content.',
    },
];

export default function Settings(): React.ReactElement {
    const [theme, setTheme] = useState<Theme>(() => {
        const stored = localStorage.getItem('theme');
        if (stored === 'dark' || stored === 'light') return stored;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    });

    const [hardwareMode, setHardwareMode] = useState<HardwareMode>(() => readSetting('hardwareMode'));
    const [modelPath, setModelPath] = useState(() => readSetting('modelPath'));
    const [mmprojPath, setMmprojPath] = useState(() => readSetting('mmprojPath'));
    const [pathsSaved, setPathsSaved] = useState(false);

    const applyTheme = (next: Theme) => {
        setTheme(next);
        writeSetting('theme', next);
        document.documentElement.classList.toggle('dark', next === 'dark');
    };

    const applyHardwareMode = (next: HardwareMode) => {
        setHardwareMode(next);
        writeSetting('hardwareMode', next);
    };

    const browseForGguf = async (setter: (path: string) => void) => {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const result = await open({
            filters: [{ name: 'GGUF Model', extensions: ['gguf'] }],
            multiple: false,
        });
        if (typeof result === 'string') {
            setter(result);
            setPathsSaved(false);
        }
    };

    const savePaths = () => {
        writeSetting('modelPath', modelPath);
        writeSetting('mmprojPath', mmprojPath);
        setPathsSaved(true);
    };

    return (
        <main className="absolute inset-0 overflow-y-auto bg-surface">
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-primary via-transparent to-transparent" />

            <div className="relative z-10 max-w-4xl mx-auto px-[--spacing-margin-page] py-16 flex flex-col gap-16">

                {/* ── Hero ── */}
                <section>
                    <h1 className="font-display-lg text-display-lg text-primary tracking-tight">Settings</h1>
                    <p className="font-body-lg text-body-lg text-on-surface-variant mt-3 max-w-xl">
                        Configure Artifact's appearance, hardware mode, and AI model paths.
                    </p>
                </section>

                {/* ── Appearance ── */}
                <Section title="Appearance">
                    <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                        <SettingRow label="Theme" description="Choose light or dark mode for the interface.">
                            <div className="flex rounded-lg border border-outline-variant overflow-hidden">
                                {(['light', 'dark'] as Theme[]).map((t) => (
                                    <button
                                        key={t}
                                        type="button"
                                        onClick={() => applyTheme(t)}
                                        className={`flex items-center gap-1.5 px-4 py-2 font-label-md text-label-md transition-colors ${
                                            theme === t
                                                ? 'bg-primary text-on-primary'
                                                : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                                        }`}
                                    >
                                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                                            {t === 'light' ? 'light_mode' : 'dark_mode'}
                                        </span>
                                        {t === 'light' ? 'Light' : 'Dark'}
                                    </button>
                                ))}
                            </div>
                        </SettingRow>
                    </div>
                </Section>

                {/* ── Hardware Mode ── */}
                <Section
                    title="Hardware mode"
                    description="Controls which AI models are loaded. Takes effect on next server start."
                >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {HARDWARE_OPTIONS.map(({ value, label, heading, body }) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => applyHardwareMode(value)}
                                className={`text-left rounded-[10px] border p-6 flex flex-col gap-3 transition-colors ${
                                    hardwareMode === value
                                        ? 'border-primary bg-primary/5'
                                        : 'border-outline-variant bg-surface-container hover:bg-surface-container-high'
                                }`}
                            >
                                <div className="flex items-center justify-between">
                                    <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">{label}</p>
                                    {hardwareMode === value && (
                                        <span
                                            className="material-symbols-outlined text-primary"
                                            style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}
                                        >
                                            check_circle
                                        </span>
                                    )}
                                </div>
                                <h3 className="font-headline-md text-headline-md text-on-surface">{heading}</h3>
                                <p className="font-body-md text-body-md text-on-surface-variant">{body}</p>
                            </button>
                        ))}
                    </div>
                </Section>

                {/* ── AI Model ── */}
                <Section
                    title="AI model"
                    description="Override the default bundled model paths. Leave blank to use bundled defaults. Saved paths take effect on next server start."
                >
                    <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-6">
                        <PathField
                            label="Model path"
                            hint="GGUF model file (e.g. Qwen3.5-4B-Q4_K_M.gguf)"
                            value={modelPath}
                            onChange={(v) => { setModelPath(v); setPathsSaved(false); }}
                            onBrowse={() => browseForGguf(setModelPath)}
                        />
                        <PathField
                            label="Multimodal projector path"
                            hint="mmproj GGUF file — only used in High-end mode"
                            value={mmprojPath}
                            onChange={(v) => { setMmprojPath(v); setPathsSaved(false); }}
                            onBrowse={() => browseForGguf(setMmprojPath)}
                            disabled={hardwareMode === 'low-end'}
                        />
                        <div className="flex items-center gap-3 pt-1 border-t border-outline-variant">
                            <button
                                type="button"
                                onClick={savePaths}
                                className="mt-4 px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-primary/90 transition-colors"
                            >
                                Save paths
                            </button>
                            {pathsSaved && (
                                <span className="mt-4 flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
                                    <span
                                        className="material-symbols-outlined text-primary"
                                        style={{ fontSize: '16px', fontVariationSettings: "'FILL' 1" }}
                                    >
                                        check_circle
                                    </span>
                                    Saved
                                </span>
                            )}
                        </div>
                    </div>
                </Section>

                {/* ── OCR ── */}
                <Section title="OCR" description="Optical character recognition settings.">
                    <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                        <SettingRow
                            label="Language"
                            description="Additional language packs (.traineddata files) coming in a future release."
                        >
                            <span className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-outline-variant bg-surface font-label-md text-label-md text-on-surface-variant">
                                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>translate</span>
                                English (eng)
                            </span>
                        </SettingRow>
                    </div>
                </Section>

            </div>
        </main>
    );
}
