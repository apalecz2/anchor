import React, { useState } from 'react';
import { Link } from 'react-router';
import { type Theme } from '../lib/settings';
import { eulaAcceptedAt } from '../features/legal/eulaAcceptance';
import { useTheme } from '../hooks/useTheme';
import { requestSetupRerun } from '../features/setup/useSetupCheck';
import { deleteAllSessions } from '../features/sessions/sessionActions';
import {
    removeAllAppData,
    planAfterRemoval,
    quitApp,
    type RemovalMode,
} from '../features/settings/appDataActions';
import ConfirmDialog from '../components/ConfirmDialog';
import Icon from '../components/Icon';
import PageContainer from '../components/PageContainer';
import Section from '../components/PageSection';
import CustomModelSection from '../features/settings/CustomModelSection';

/** Label/description on the left, control on the right. Below `sm` the control
 *  drops onto its own line instead of competing with the text for width: at the
 *  narrow end the app supports, a side-by-side row squeezes the description to
 *  one word per line long before the control stops fitting.
 *
 *  `items-start` is load-bearing once stacked: a column flex container stretches
 *  its children to full width, which pulls a control's own border (the theme
 *  toggle's, say) out to the row edge while the buttons inside it stay
 *  content-width. Controls must size to their content in both directions. */
function SettingRow({ label, description, children }: {
    label: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col items-start sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-8 px-5 py-4">
            {/* The text block is the one child that *should* span the row when
                stacked, so it opts back in explicitly. */}
            <div className="w-full min-w-0 sm:w-auto sm:flex-1">
                <p className="font-body-md text-body-md text-on-surface font-medium">{label}</p>
                {description && (
                    <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{description}</p>
                )}
            </div>
            <div className="sm:shrink-0">{children}</div>
        </div>
    );
}

/* Shared button styling for the Data section. The filled variant marks the two
   actions that end something outright (all sessions, the whole install); the outlined
   one marks the reset, which puts the app back where it started rather than away. */
const DESTRUCTIVE_FILLED =
    'flex items-center gap-1.5 px-4 py-2 rounded-lg bg-error text-on-error font-label-md text-label-md hover:bg-error/90 transition-colors disabled:opacity-50 disabled:pointer-events-none';
const DESTRUCTIVE_OUTLINED =
    'flex items-center gap-1.5 px-4 py-2 rounded-lg border border-error/50 bg-surface-container text-error font-label-md text-label-md hover:bg-error/10 transition-colors disabled:opacity-50 disabled:pointer-events-none';

/* The two removals run the identical wipe and differ only in what happens after, so
   their copy is written together — neither may read as if it keeps more than the
   other. Both name the ~3.5 GB explicitly: that download is the whole reason this
   action exists (docs/release.md §6.4), and it is what a user reclaiming disk space
   or uninstalling is actually looking for.

   Each description states what is deleted in full rather than referring to the row
   above it. Someone scanning for "how do I get my disk space back" reads one row, not
   the section in order, and a description that only makes sense after its neighbour
   leaves them guessing at what the other one keeps. The shared opening clause is
   therefore repeated verbatim, not paraphrased: identical wording is what makes the
   differing tail — return to setup, or close — the only thing the eye has to compare. */
const REMOVAL_COPY: Record<RemovalMode, {
    label: string;
    description: string;
    icon: string;
    buttonLabel: string;
    buttonClass: string;
    dialogTitle: string;
    dialogDescription: string;
    confirmLabel: string;
}> = {
    reset: {
        label: 'Reset Anchor',
        description:
            'Removes every session, your settings, and the OCR engine, AI model, and libraries downloaded during setup (about 3.5 GB), then returns to first-run setup so Anchor can download them again. Your original files and saved exports are left untouched.',
        icon: 'settings_backup_restore',
        buttonLabel: 'Reset',
        buttonClass: DESTRUCTIVE_OUTLINED,
        dialogTitle: 'Reset Anchor?',
        dialogDescription:
            'This deletes every session, your settings, and the roughly 3.5 GB of components downloaded during setup, then returns to first-run setup so they can be downloaded again. Your original files and any exports you saved elsewhere are left untouched. This cannot be undone.',
        confirmLabel: 'Reset Anchor',
    },
    uninstall: {
        label: 'Remove all data and quit',
        description:
            'Removes every session, your settings, and the OCR engine, AI model, and libraries downloaded during setup (about 3.5 GB), then closes Anchor. Do this before uninstalling: uninstalling removes the program, but leaves those downloaded components on this device.',
        icon: 'power_settings_new',
        buttonLabel: 'Remove and quit',
        buttonClass: DESTRUCTIVE_FILLED,
        dialogTitle: 'Remove all data and quit?',
        dialogDescription:
            'This deletes every session, your settings, and the roughly 3.5 GB of components downloaded during setup, then closes Anchor. Your original files and any exports you saved elsewhere are left untouched. Opening Anchor again starts first-run setup. This cannot be undone.',
        confirmLabel: 'Remove and quit',
    },
};

/** How long the "Removed 3.5 GB. Closing Anchor…" summary stays up before the app
 *  exits: long enough to read, short enough that the app doesn't look hung. */
const QUIT_DELAY_MS = 1400;

export default function Settings(): React.ReactElement {
    const [theme, setTheme] = useTheme();

    const acceptedAt = eulaAcceptedAt();

    const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteResult, setDeleteResult] = useState<string | null>(null);

    const [confirmRemoval, setConfirmRemoval] = useState<RemovalMode | null>(null);
    const [removing, setRemoving] = useState(false);
    const [removalResult, setRemovalResult] = useState<string | null>(null);

    // One destructive action at a time: they all touch the same files, and a wipe
    // racing a session delete would leave both reporting nonsense.
    const busy = deleting || removing;

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

    const handleRemoveAllData = async (mode: RemovalMode) => {
        setConfirmRemoval(null);
        setRemoving(true);
        setRemovalResult(null);
        try {
            const report = await removeAllAppData(mode);
            if (report.failed.length > 0) console.warn('Could not remove:', report.failed);

            const outcome = planAfterRemoval(report, mode);
            if (outcome.next === 'stay') {
                setRemovalResult(outcome.message);
                setRemoving(false);
                return;
            }

            // `removing` deliberately stays true from here: the buttons are inert for
            // the moment before the webview reloads or the process exits.
            if (outcome.next === 'reload') {
                window.location.reload();
                return;
            }

            setRemovalResult(outcome.message);
            setTimeout(() => { void quitApp(); }, QUIT_DELAY_MS);
        } catch (error) {
            console.error('Failed to remove app data:', error);
            setRemovalResult('Something went wrong while removing app data. Nothing else was changed.');
            setRemoving(false);
        }
    };

    return (
        <>
            <PageContainer
                title="Settings"
                description="Configure Anchor's appearance, AI model paths, and setup."
            >

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
                                        <Icon name={t === 'light' ? 'light_mode' : 'dark_mode'} size={16} />
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
                    description="Anchor extracts tables with the model it downloaded during setup. You can point it at a different one instead."
                >
                    <CustomModelSection />
                </Section>

                {/* ── OCR ── */}
                <Section title="OCR" description="Optical character recognition settings." comingSoon>
                    <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                        <SettingRow
                            label="Language"
                            description="This version recognizes English only. Other languages are not yet supported."
                        >
                            <span className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-outline-variant bg-surface font-label-md text-label-md text-on-surface-variant">
                                <Icon name="translate" size={14} />
                                English only
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
                                <Icon name="restart_alt" size={16} />
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
                            <div className="flex flex-wrap items-center gap-3">
                                {deleteResult && (
                                    <span className="font-body-sm text-body-sm text-on-surface-variant">
                                        {deleteResult}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => { setDeleteResult(null); setConfirmDeleteAll(true); }}
                                    disabled={busy}
                                    className={DESTRUCTIVE_FILLED}
                                >
                                    <Icon name="delete_forever" size={16} />
                                    {deleting ? 'Deleting…' : 'Delete all'}
                                </button>
                            </div>
                        </SettingRow>

                        {/* The two whole-install removals. Rendered from one table so the
                            pair can't drift into describing different amounts of data. */}
                        {(Object.keys(REMOVAL_COPY) as RemovalMode[]).map((mode) => {
                            const copy = REMOVAL_COPY[mode];
                            return (
                                <SettingRow key={mode} label={copy.label} description={copy.description}>
                                    <button
                                        type="button"
                                        onClick={() => { setRemovalResult(null); setConfirmRemoval(mode); }}
                                        disabled={busy}
                                        className={copy.buttonClass}
                                    >
                                        <Icon name={copy.icon} size={16} />
                                        {removing ? 'Removing…' : copy.buttonLabel}
                                    </button>
                                </SettingRow>
                            );
                        })}
                    </div>
                    {removalResult && (
                        <p className="font-body-sm text-body-sm text-on-surface-variant px-1" role="status">
                            {removalResult}
                        </p>
                    )}
                </Section>

                {/* ── Legal ── */}
                <Section
                    title="Legal"
                    description="Anchor's terms, privacy policy, and the licenses of the components it's built with."
                >
                    <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                        {[
                            { to: '/legal/privacy', icon: 'shield', label: 'Privacy Policy' },
                            { to: '/legal/terms', icon: 'gavel', label: 'Terms of Use & EULA' },
                            { to: '/legal/notices', icon: 'balance', label: 'Licenses & Notices' },
                        ].map(({ to, icon, label }) => (
                            <Link
                                key={to}
                                to={to}
                                className="flex items-center gap-3 px-5 py-4 hover:bg-surface-container-high transition-colors no-underline"
                            >
                                <Icon name={icon} size={18} className="text-primary shrink-0" />
                                <span className="min-w-0 flex-1 font-body-md text-body-md text-on-surface font-medium">{label}</span>
                                <Icon name="chevron_right" size={20} className="text-on-surface-variant shrink-0" />
                            </Link>
                        ))}
                    </div>
                    {acceptedAt && (
                        <p className="font-body-sm text-body-sm text-on-surface-variant px-1">
                            You accepted the current Terms &amp; Privacy Policy on {new Date(acceptedAt).toLocaleDateString()}.
                        </p>
                    )}
                </Section>

                <p className="font-body-sm text-body-sm text-on-surface-variant/40 text-center pb-2">
                    <Link to="/about" className="text-inherit no-underline hover:text-on-surface-variant transition-colors">
                        About Anchor &amp; version
                    </Link>
                </p>

            </PageContainer>

            <ConfirmDialog
                open={confirmDeleteAll}
                title="Delete all sessions?"
                description="This permanently deletes every session and the data Anchor has copied for itself. It only touches the app's own data: your original attached files and any outputs you saved elsewhere are left untouched. This cannot be undone."
                confirmLabel="Delete all"
                onConfirm={handleDeleteAllSessions}
                onCancel={() => setConfirmDeleteAll(false)}
            />

            {confirmRemoval && (
                <ConfirmDialog
                    open
                    title={REMOVAL_COPY[confirmRemoval].dialogTitle}
                    description={REMOVAL_COPY[confirmRemoval].dialogDescription}
                    confirmLabel={REMOVAL_COPY[confirmRemoval].confirmLabel}
                    onConfirm={() => { void handleRemoveAllData(confirmRemoval); }}
                    onCancel={() => setConfirmRemoval(null)}
                />
            )}
        </>
    );
}
