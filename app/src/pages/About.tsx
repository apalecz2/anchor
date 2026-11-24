import React, { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import Icon from '../components/Icon';
import PageContainer from '../components/PageContainer';
import Section from '../components/PageSection';
import { copyTextToClipboard } from '../utils/clipboard';
import { copyrightYears } from '../utils/copyright';
import { hasSetting, readSetting } from '../lib/settings';
import {
    buildDiagnostics,
    formatDiagnostics,
    type InstallInfo,
} from '../features/about/installInfo';
import { backendWarning } from '../features/setup/backend';
import type { Backend, HardwareInfo, SetupPaths } from '../features/setup/types';

/* This page is deliberately *not* a second copy of the marketing site. Anything
   that argues Anchor is worth installing belongs on the website; the reader here
   already installed it. What lives here is what the website cannot know (which
   build is running, on what hardware, from where) and what the app itself cannot
   explain in situ (how to read the confidence heatmap). Product copy that was
   duplicated from the site drifted out of date and shipped wrong claims, so the
   rule is: if the website could say it, it doesn't go here. */

const LINKS = {
    github: 'https://github.com/apalecz2/anchor',
    issues: 'https://github.com/apalecz2/anchor/issues',
    email: 'aiden.paleczny@gmail.com',
};

/** Open an external target through the OS, never in the webview. */
function external(href: string): (e: React.MouseEvent) => void {
    return (e) => {
        e.preventDefault();
        void openUrl(href);
    };
}

/* ── This install ─────────────────────────────────────────────────────────── */

/** Everything the panel needs except the GPU probe, which is fetched separately. */
interface FastFacts {
    version: string | null;
    install: InstallInfo | null;
    backend: Backend | null;
    modelPath: string | null;
}

function DiagnosticsPanel(): React.ReactElement {
    const [facts, setFacts] = useState<FastFacts | null>(null);
    const [hardware, setHardware] = useState<HardwareInfo | null>(null);
    const [hardwarePending, setHardwarePending] = useState(true);
    const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

    useEffect(() => {
        let cancelled = false;

        // Every probe is independent and every one is allowed to fail: a machine
        // that can't report its GPU should still show its version and paths,
        // since a partly-filled report still beats no report.
        const settle = <T,>(p: Promise<T>): Promise<T | null> => p.then((v) => v).catch(() => null);

        // Two chains, not one Promise.all. `detect_hardware` shells out to WMI /
        // nvidia-smi / system_profiler and can take seconds; the rest resolve in
        // milliseconds. Awaiting them together would hold the whole panel behind
        // the slowest one for no reason.
        void Promise.all([
            settle(import('@tauri-apps/api/app').then(({ getVersion }) => getVersion())),
            settle(invoke<InstallInfo>('get_install_info')),
            settle(invoke<SetupPaths>('get_setup_paths')),
        ]).then(([version, install, paths]) => {
            if (cancelled) return;

            // localStorage is the live value (useSetupCheck heals it from disk on
            // launch); the AppData copy is the fallback for an origin that never
            // ran the wizard.
            const backend: Backend | null = hasSetting('hardwareBackend')
                ? readSetting('hardwareBackend')
                : paths?.hardware_backend ?? null;
            const modelPath = readSetting('modelPath') || paths?.model_path || null;

            setFacts({ version, install, backend, modelPath });
        });

        void settle(invoke<HardwareInfo>('detect_hardware')).then((hw) => {
            if (cancelled) return;
            setHardware(hw);
            setHardwarePending(false);
        });

        // Navigating away can't recall an in-flight command — Tauri's IPC has no
        // cancel — but the probe now runs on a backend worker thread, so leaving
        // is instant and the orphaned result is simply dropped here.
        return () => { cancelled = true; };
    }, []);

    const fields = facts
        ? buildDiagnostics({ ...facts, hardware, hardwarePending })
        : null;
    // Same check the wizard runs before installing, re-run against the machine as
    // it is now: the installed build is fixed at setup, but the hardware under it
    // can change afterwards.
    const mismatch = facts?.backend && hardware ? backendWarning(facts.backend, hardware) : null;
    const dataDir = facts?.install?.data_dir ?? null;

    const onCopy = async () => {
        if (!fields) return;
        setCopied(await copyTextToClipboard(formatDiagnostics(fields)) ? 'ok' : 'fail');
        setTimeout(() => setCopied('idle'), 2000);
    };

    const onReveal = () => {
        if (!dataDir) return;
        void import('@tauri-apps/plugin-opener')
            .then(({ revealItemInDir }) => revealItemInDir(dataDir))
            .catch(() => {});
    };

    if (!fields) {
        return (
            <div className="rounded-[10px] border border-outline-variant bg-surface-container px-5 py-4">
                <p className="font-body-md text-body-md text-on-surface-variant">Reading system information…</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                {fields.map(({ label, value, mono }) => (
                    <div key={label} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 px-5 py-3">
                        <p className="font-label-md text-label-md text-on-surface-variant sm:w-36 sm:shrink-0 sm:mt-0.5">
                            {label}
                        </p>
                        <p
                            className={`min-w-0 flex-1 text-on-surface ${
                                mono
                                    ? 'font-mono-data text-body-sm wrap-break-word'
                                    : 'font-body-md text-body-md font-medium'
                            }`}
                        >
                            {value}
                        </p>
                    </div>
                ))}
            </div>

            {mismatch && (
                <div className="flex items-start gap-3 rounded-[10px] border border-outline-variant bg-surface-container-high px-5 py-4">
                    <Icon name="warning" size={20} weight={300} className="text-error shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <p className="font-body-sm text-body-sm text-on-surface-variant">{mismatch}</p>
                        <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                            <Link to="/settings" className="text-primary underline underline-offset-2">Re-run setup</Link>
                            {' '}to install a build that matches this machine.
                        </p>
                    </div>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    onClick={onCopy}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-primary/90 transition-colors"
                >
                    <Icon name={copied === 'ok' ? 'check' : 'content_copy'} size={16} />
                    {copied === 'ok' ? 'Copied' : 'Copy details'}
                </button>
                {dataDir && (
                    <button
                        type="button"
                        onClick={onReveal}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-outline-variant bg-surface-container hover:bg-surface-container-high font-label-md text-label-md text-on-surface transition-colors"
                    >
                        <Icon name="folder_open" size={16} />
                        Open data folder
                    </button>
                )}
                {copied === 'fail' && (
                    <span className="font-body-sm text-body-sm text-on-surface-variant">
                        Couldn't copy. Select the text above instead.
                    </span>
                )}
            </div>
            <p className="font-body-sm text-body-sm text-on-surface-variant px-1">
                Include these details when reporting a problem. They stay on your device until you paste them
                somewhere yourself.
            </p>
        </div>
    );
}

/* ── Reading the results ──────────────────────────────────────────────────── */

/* Swatch classes are copied from ProvenanceTable's TRUST_BG/TRUST_TEXT rather
   than re-derived, so the legend can't describe a palette the table doesn't
   use. If those change, change these. */
const LEGEND: { swatch: string; label: string; body: string }[] = [
    {
        swatch: 'bg-green-100 dark:bg-green-500/15 text-green-900 dark:text-green-200',
        label: 'High confidence',
        body: 'The AI and the OCR text agree, and both read it cleanly. Spot-check only.',
    },
    {
        swatch: 'bg-amber-100 dark:bg-amber-500/15 text-amber-900 dark:text-amber-200',
        label: 'Medium confidence',
        body: 'Readable, but something was less certain than usual. Worth a glance.',
    },
    {
        swatch: 'bg-red-100 dark:bg-red-500/15 text-red-900 dark:text-red-200',
        label: 'Low confidence',
        body: 'The AI and OCR disagree, or the page was hard to read here. Check this one.',
    },
    {
        swatch: 'bg-surface-variant/60 text-on-surface-variant',
        label: 'No OCR match',
        body: 'Read from the image only, with no OCR word to confirm it against.',
    },
];

const BADGES: { glyph: string; body: string }[] = [
    { glyph: '✓', body: 'You checked (or corrected) this cell yourself. Overrides every warning below.' },
    { glyph: '?', body: 'No matching OCR word, so the value came from the image alone.' },
    { glyph: '≈', body: 'Approximate match: the value differs slightly from the OCR text, often a single misread character.' },
    { glyph: '!', body: 'Low confidence, or a blank cell where unextracted text was found on the page.' },
];

function ReadingResults(): React.ReactElement {
    return (
        <div className="flex flex-col gap-4">
            <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                {LEGEND.map(({ swatch, label, body }) => (
                    <div key={label} className="flex items-start gap-4 px-5 py-4">
                        <span className={`shrink-0 rounded-sm border border-outline-variant px-2.5 py-1 font-mono-data text-body-sm ${swatch}`}>
                            123
                        </span>
                        <div className="min-w-0">
                            <p className="font-body-md text-body-md text-on-surface font-medium">{label}</p>
                            <p className="font-body-sm text-body-sm text-on-surface-variant">{body}</p>
                        </div>
                    </div>
                ))}
            </div>

            <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                {BADGES.map(({ glyph, body }) => (
                    <div key={glyph} className="flex items-start gap-4 px-5 py-3">
                        <span className="inline-flex shrink-0 h-6 w-6 items-center justify-center rounded-full bg-surface-variant text-body-sm font-medium text-on-surface-variant">
                            {glyph}
                        </span>
                        <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{body}</p>
                    </div>
                ))}
            </div>

            <p className="font-body-md text-body-md text-on-surface-variant">
                Click any cell to highlight the exact spot on the page it was read from. Click again to edit it.
                An edited or confirmed cell is marked verified and stops being flagged.
            </p>
        </div>
    );
}

/* ── Troubleshooting ──────────────────────────────────────────────────────── */

function Troubleshooting(): React.ReactElement {
    const items: { icon: string; title: string; body: React.ReactNode }[] = [
        {
            icon: 'speed',
            title: 'Extraction is slow',
            body: (
                <>
                    Compare the <span className="text-on-surface">Installed build</span> and{' '}
                    <span className="text-on-surface">Graphics</span> rows above. A GPU build only accelerates the
                    card it was made for. On anything else it falls back to CPU speed.{' '}
                    <Link to="/settings" className="text-primary underline underline-offset-2">Re-run setup</Link>{' '}
                    to switch builds.
                </>
            ),
        },
        {
            icon: 'build',
            title: 'Something is missing or setup failed',
            body: (
                <>
                    <Link to="/settings" className="text-primary underline underline-offset-2">Re-run the setup wizard</Link>.
                    It re-checks every component and reinstalls only what's missing or corrupt, so it's safe to run any time.
                </>
            ),
        },
        {
            icon: 'wifi_off',
            title: 'No internet',
            body: 'Only first-run setup needs a connection. Once the engine and model are installed, extraction runs fully offline.',
        },
        {
            icon: 'hard_drive',
            title: 'Reclaiming disk space',
            body: (
                <>
                    Sessions and cached page images live in the data folder above.{' '}
                    <Link to="/settings" className="text-primary underline underline-offset-2">Delete all sessions</Link>{' '}
                    clears them without touching your original files. The same section can remove
                    everything Anchor downloaded (about 3.5 GB), including before uninstalling.
                </>
            ),
        },
    ];

    return (
        <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
            {items.map(({ icon, title, body }) => (
                <div key={title} className="flex items-start gap-4 px-5 py-4">
                    <Icon name={icon} size={20} weight={300} className="text-primary shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <p className="font-body-md text-body-md text-on-surface font-medium">{title}</p>
                        <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{body}</p>
                    </div>
                </div>
            ))}
        </div>
    );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function About(): React.ReactElement {
    return (
        <PageContainer
            title="About"
            description="Anchor turns tables in scanned documents and photos into spreadsheets, entirely on this machine. Nothing you open is uploaded anywhere."
        >

            {/* ── This install ── */}
            <Section
                title="This install"
                description="What's running on this machine, and where Anchor keeps its files."
            >
                <DiagnosticsPanel />
            </Section>

            {/* ── Reading the results ── */}
            <Section
                title="Reading the results"
                description="Every extracted cell is colored by how confident Anchor is in it, so you can check the handful of shaky values instead of proofreading the whole table."
            >
                <ReadingResults />
            </Section>

            {/* ── Troubleshooting ── */}
            <Section title="If something goes wrong">
                <Troubleshooting />
            </Section>

            {/* ── Support ── */}
            <Section
                title="Support"
                description="Bug reports and questions are welcome. Including the details above makes them much faster to answer."
            >
                <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                    {[
                        { icon: 'bug_report', label: 'Report an issue', note: 'GitHub Issues', href: LINKS.issues },
                        { icon: 'code', label: 'Source code', note: LINKS.github.replace('https://', ''), href: LINKS.github },
                        { icon: 'mail', label: 'Email', note: LINKS.email, href: `mailto:${LINKS.email}` },
                    ].map(({ icon, label, note, href }) => (
                        <a
                            key={label}
                            href={href}
                            onClick={external(href)}
                            className="flex items-center gap-4 px-5 py-4 hover:bg-surface-container-high transition-colors no-underline"
                        >
                            <Icon name={icon} size={20} weight={300} className="text-primary shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="font-body-md text-body-md text-on-surface font-medium">{label}</p>
                                <p className="font-body-sm text-body-sm text-on-surface-variant wrap-break-word">{note}</p>
                            </div>
                            <Icon name="open_in_new" size={18} className="text-on-surface-variant shrink-0" />
                        </a>
                    ))}
                </div>
            </Section>

            {/* ── AI-output notice ── */}
            <section className="rounded-[10px] border border-outline-variant bg-surface-container p-5 sm:p-6 flex gap-4">
                <Icon name="auto_awesome" size={20} weight={300} className="text-primary shrink-0 mt-0.5" />
                <p className="font-body-md text-body-md text-on-surface-variant">
                    Anchor extracts tables using a local generative-AI model. AI output can be inaccurate or
                    incomplete, so always verify extracted data against the source document before relying on it.
                    The confidence heatmap and click-to-source highlighting are aids to that review, not a
                    guarantee of accuracy.
                </p>
            </section>

            {/* ── Legal ── */}
            <Section title="Legal">
                <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                    {[
                        { to: '/legal/privacy', icon: 'shield', label: 'Privacy Policy', note: 'What Anchor processes and where (everything stays on your device).' },
                        { to: '/legal/terms', icon: 'gavel', label: 'Terms of Use & EULA', note: 'License to use, AI-output disclaimer, and warranty terms.' },
                        { to: '/legal/notices', icon: 'balance', label: 'Licenses & Notices', note: 'Third-party components and AI models Anchor is built with.' },
                    ].map(({ to, icon, label, note }) => (
                        <Link key={to} to={to} className="flex items-center gap-4 px-5 py-4 hover:bg-surface-container-high transition-colors no-underline">
                            <Icon name={icon} size={20} weight={300} className="text-primary shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="font-body-md text-body-md text-on-surface font-medium">{label}</p>
                                <p className="font-body-sm text-body-sm text-on-surface-variant">{note}</p>
                            </div>
                            <Icon name="chevron_right" size={20} className="text-on-surface-variant shrink-0" />
                        </Link>
                    ))}
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                    Anchor · Copyright © {copyrightYears()} Aiden Paleczny · Licensed under the Elastic License 2.0.
                    Security, copyright, or AI-output concerns:{' '}
                    <a
                        href={`mailto:${LINKS.email}`}
                        onClick={external(`mailto:${LINKS.email}`)}
                        className="text-primary underline underline-offset-2 cursor-pointer wrap-break-word"
                    >
                        {LINKS.email}
                    </a>.
                </p>
            </Section>

        </PageContainer>
    );
}
