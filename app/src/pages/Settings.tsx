import React, { useState } from 'react';
import { readSetting, writeSetting, type Theme } from '../lib/settings';
import { useTheme } from '../hooks/useTheme';
import { requestSetupRerun } from '../features/setup/useSetupCheck';
import { deleteAllSessions } from '../features/sessions/sessionActions';
import ConfirmDialog from '../components/ConfirmDialog';

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
                    placeholder="Leave blank to use the model installed by setup"
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

export default function Settings(): React.ReactElement {
    const [theme, setTheme] = useTheme();

    const [modelPath, setModelPath] = useState(() => readSetting('modelPath'));
    const [mmprojPath, setMmprojPath] = useState(() => readSetting('mmprojPath'));
    const [pathsSaved, setPathsSaved] = useState(false);

    const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteResult, setDeleteResult] = useState<string | null>(null);

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

    const handleDeleteAllSessions = async () => {
        setConfirmDeleteAll(false);
        setDeleting(true);
        setDeleteResult(null);
        try {
            const count = await deleteAllSessions();
            setDeleteResult(
                count === 0
                    ? 'No sessions to delete.'
                    : `Deleted ${count} session${count === 1 ? '' : 's'}.`,
            );
        } catch (error) {
            console.error('Failed to delete all sessions:', error);
            setDeleteResult('Something went wrong while deleting sessions.');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <main className="absolute inset-0 overflow-y-auto bg-surface">
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-primary via-transparent to-transparent" />

            <div className="relative z-10 max-w-4xl mx-auto px-[--spacing-margin-page] py-16 flex flex-col gap-16">

                {/* ── Hero ── */}
                <section>
                    <h1 className="font-display-lg text-display-lg text-primary tracking-tight">Settings</h1>
                    <p className="font-body-lg text-body-lg text-on-surface-variant mt-3 max-w-xl">
                        Configure Artifact's appearance, AI model paths, and setup.
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
                                        onClick={() => setTheme(t)}
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

                {/* ── AI Model ── */}
                <Section
                    title="AI model"
                    description="Override the model paths installed by setup. Leave blank to use the downloaded model. Saved paths take effect on next server start."
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
                            hint="mmproj GGUF file — required for the vision pipeline"
                            value={mmprojPath}
                            onChange={(v) => { setMmprojPath(v); setPathsSaved(false); }}
                            onBrowse={() => browseForGguf(setMmprojPath)}
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

                {/* ── Setup ── */}
                <Section
                    title="Setup"
                    description="Re-run the first-run wizard to re-verify or repair the downloaded engine, model, and libraries. Assets you already have are skipped, so this is safe to run any time something seems missing."
                >
                    <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                        <SettingRow
                            label="Re-run setup wizard"
                            description="Re-checks every component and reinstalls anything missing or corrupt."
                        >
                            <button
                                type="button"
                                onClick={requestSetupRerun}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-outline-variant bg-surface-container hover:bg-surface-container-high font-label-md text-label-md text-on-surface transition-colors"
                            >
                                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>restart_alt</span>
                                Re-run setup
                            </button>
                        </SettingRow>
                    </div>
                </Section>

                {/* ── Data ── */}
                <Section
                    title="Data"
                    description="Manage the extraction data stored on this device."
                >
                    <div className="rounded-[10px] border border-error/40 bg-surface-container divide-y divide-outline-variant">
                        <SettingRow
                            label="Delete all sessions"
                            description="Permanently removes every session and related data from this device. Your original attached files and any outputs you saved elsewhere are left untouched. This cannot be undone."
                        >
                            <div className="flex items-center gap-3">
                                {deleteResult && (
                                    <span className="font-body-sm text-body-sm text-on-surface-variant">
                                        {deleteResult}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => { setDeleteResult(null); setConfirmDeleteAll(true); }}
                                    disabled={deleting}
                                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-error text-on-error font-label-md text-label-md hover:bg-error/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                                >
                                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete_forever</span>
                                    {deleting ? 'Deleting…' : 'Delete all'}
                                </button>
                            </div>
                        </SettingRow>
                    </div>
                </Section>

            </div>

            <ConfirmDialog
                open={confirmDeleteAll}
                title="Delete all sessions?"
                description="This permanently deletes every session and the data Artifact has copied for itself. It only touches the app's own data — your original attached files and any outputs you saved elsewhere are left untouched. This cannot be undone."
                confirmLabel="Delete all"
                onConfirm={handleDeleteAllSessions}
                onCancel={() => setConfirmDeleteAll(false)}
            />
        </main>
    );
}
