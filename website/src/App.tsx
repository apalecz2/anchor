import React from 'react';
import Icon from './components/Icon';
import AnchorMark from './components/AnchorMark';
import { syncFaviconToSystemTheme } from './favicon';

/* ─────────────────────────────────────────────────────────────────────────
   Project links. These are the only values you'll likely need to edit before
   publishing — kept together so they're easy to find and swap.
   ───────────────────────────────────────────────────────────────────────── */
const LINKS = {
    /** Public repository. */
    github: 'https://github.com/apalecz2/anchor',
    /** GitHub Releases page — the primary Windows download (release-strategy.md, Phase 1). */
    releases: 'https://github.com/apalecz2/anchor/releases/latest',
    /** Microsoft Store listing — planned (release-strategy.md, Phase 3). Leave empty until live. */
    microsoftStore: '',
    /** macOS DMG — deferred (release-strategy.md, Phase 4). Leave empty until shipped. */
    macDownload: '',
};

const NAV = [
    { href: '#features', label: 'Features' },
    { href: '#how', label: 'How it works' },
    { href: '#deep-dive', label: 'Deeper look' },
    { href: '#download', label: 'Download' },
];

/* ── Header ──────────────────────────────────────────────────────────────── */

function Logo(): React.ReactElement {
    return (
        <a href="#top" className="flex items-center gap-2 text-on-surface no-underline">
            <AnchorMark className="w-9 h-9 rounded-lg" />
            <span className="font-headline-md text-headline-md leading-none">Anchor</span>
        </a>
    );
}

function ThemeToggle(): React.ReactElement {
    // Seed from whatever the pre-paint script in index.html already resolved
    // (saved choice, else system), so the toggle agrees with what's on screen.
    const [dark, setDark] = React.useState(() => document.documentElement.classList.contains('dark'));

    // Mirror the current value onto <html>. We deliberately do NOT write
    // localStorage here — only an explicit toggle persists a choice, so a
    // visitor who never touches the toggle keeps following their system setting.
    React.useEffect(() => {
        document.documentElement.classList.toggle('dark', dark);
    }, [dark]);

    // Until the visitor makes an explicit choice, track OS theme changes live
    // (e.g. the system flips to dark on schedule). Once a choice is stored, the
    // saved value wins and system changes are ignored.
    React.useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e: MediaQueryListEvent) => {
            if (!localStorage.getItem('theme')) setDark(e.matches);
        };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);

    const toggle = () =>
        setDark((d) => {
            const next = !d;
            localStorage.setItem('theme', next ? 'dark' : 'light');
            return next;
        });

    return (
        <button
            type="button"
            onClick={toggle}
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            className="w-9 h-9 rounded-full border border-outline-variant bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
        >
            <Icon name={dark ? 'light_mode' : 'dark_mode'} size={18} weight={300} />
        </button>
    );
}

function Header(): React.ReactElement {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const close = () => setMenuOpen(false);

    return (
        <header className="sticky top-0 z-50 border-b border-outline-variant bg-surface/80 backdrop-blur-md">
            <div className="max-w-6xl mx-auto px-5 sm:px-8 lg:px-[--spacing-margin-page] h-16 flex items-center justify-between gap-4">
                <Logo />
                <nav className="hidden md:flex items-center gap-1">
                    {NAV.map(({ href, label }) => (
                        <a
                            key={href}
                            href={href}
                            className="px-3 py-2 rounded-[10px] font-label-md text-label-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors no-underline"
                        >
                            {label}
                        </a>
                    ))}
                </nav>
                <div className="flex items-center gap-2">
                    <ThemeToggle />
                    <a
                        href={LINKS.github}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="View source on GitHub"
                        className="hidden sm:flex w-9 h-9 rounded-full border border-outline-variant bg-surface-container items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
                    >
                        <Icon name="code" size={18} weight={300} />
                    </a>
                    <a
                        href="#download"
                        className="hidden sm:flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-on-primary font-label-md text-label-md font-semibold hover:opacity-90 transition-opacity no-underline"
                    >
                        <Icon name="download" size={16} />
                        Download
                    </a>
                    <button
                        type="button"
                        onClick={() => setMenuOpen((o) => !o)}
                        aria-label="Toggle navigation menu"
                        aria-expanded={menuOpen}
                        className="md:hidden w-9 h-9 rounded-full border border-outline-variant bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
                    >
                        <Icon name={menuOpen ? 'close' : 'menu'} size={20} weight={300} />
                    </button>
                </div>
            </div>

            {/* Mobile dropdown nav — replaces the desktop links below the md breakpoint. */}
            {menuOpen && (
                <nav className="md:hidden border-t border-outline-variant bg-surface px-5 py-3 flex flex-col gap-1">
                    {NAV.map(({ href, label }) => (
                        <a
                            key={href}
                            href={href}
                            onClick={close}
                            className="px-3 py-2.5 rounded-[10px] font-label-md text-label-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors no-underline"
                        >
                            {label}
                        </a>
                    ))}
                    <a
                        href={LINKS.github}
                        target="_blank"
                        rel="noreferrer"
                        onClick={close}
                        className="px-3 py-2.5 rounded-[10px] font-label-md text-label-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors no-underline"
                    >
                        View source
                    </a>
                    <a
                        href="#download"
                        onClick={close}
                        className="mt-1 flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-full bg-primary text-on-primary font-label-md text-label-md font-semibold hover:opacity-90 transition-opacity no-underline"
                    >
                        <Icon name="download" size={16} />
                        Download
                    </a>
                </nav>
            )}
        </header>
    );
}

/* ── Product preview mock (split-screen heatmap) ─────────────────────────── */

function ProductPreview(): React.ReactElement {
    const trust: Record<string, string> = {
        high: 'text-trust-high',
        medium: 'text-trust-medium',
        low: 'text-trust-low',
    };
    const dot: Record<string, string> = {
        high: 'bg-trust-high',
        medium: 'bg-trust-medium',
        low: 'bg-trust-low',
    };
    // [value, trustLevel]
    const rows: [string, keyof typeof trust][][] = [
        [['CHEM 101', 'high'], ['Intro Chemistry', 'high'], ['3.0', 'high']],
        [['MATH 204', 'high'], ['Linear Algebra', 'medium'], ['4.0', 'high']],
        [['HIST 11O', 'low'], ['World History', 'high'], ['3.0', 'medium']],
        [['BIOL 150', 'high'], ['Cell Biology', 'high'], ['4.0', 'high']],
    ];

    return (
        <div className="rounded-[14px] border border-outline-variant bg-surface-container-low overflow-hidden shadow-2xl shadow-black/10">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-4 h-10 border-b border-outline-variant bg-surface-container">
                <span className="w-3 h-3 rounded-full bg-outline-variant" />
                <span className="w-3 h-3 rounded-full bg-outline-variant" />
                <span className="w-3 h-3 rounded-full bg-outline-variant" />
                <span className="ml-3 font-body-sm text-body-sm text-on-surface-variant">transcript.pdf · Anchor</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-outline-variant">
                {/* Source document pane */}
                <div className="p-5 bg-surface-bright">
                    <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-3">Source</p>
                    <div className="space-y-2.5">
                        <div className="h-3 w-2/3 rounded bg-surface-dim" />
                        <div className="h-2.5 w-1/2 rounded bg-surface-variant" />
                        <div className="mt-4 space-y-2 font-mono-data text-mono-data text-on-surface-variant">
                            <div className="flex justify-between"><span>CHEM 101</span><span>Intro Chemistry</span><span>3.0</span></div>
                            <div className="flex justify-between"><span>MATH 204</span><span>Linear Algebra</span><span>4.0</span></div>
                            <div className="flex justify-between">
                                <span className="rounded bg-trust-low/20 px-1 ring-1 ring-trust-low/40">HIST 11O</span>
                                <span>World History</span><span>3.0</span>
                            </div>
                            <div className="flex justify-between"><span>BIOL 150</span><span>Cell Biology</span><span>4.0</span></div>
                        </div>
                    </div>
                </div>

                {/* Extracted table pane */}
                <div className="p-5">
                    <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-3">Extracted · confidence heatmap</p>
                    <div className="font-mono-data text-mono-data">
                        <div className="grid grid-cols-[1fr_1.4fr_0.5fr] gap-x-2 pb-2 mb-1 border-b border-outline-variant text-on-surface-variant">
                            <span>Code</span><span>Course</span><span>Cr</span>
                        </div>
                        {rows.map((cells, i) => (
                            <div key={i} className="grid grid-cols-[1fr_1.4fr_0.5fr] gap-x-2 py-1 items-center">
                                {cells.map(([value, level], j) => (
                                    <span key={j} className={`flex items-center gap-1 ${trust[level]}`}>
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot[level]}`} />
                                        <span className="truncate">{value}</span>
                                    </span>
                                ))}
                            </div>
                        ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 font-body-sm text-body-sm text-on-surface-variant">
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-trust-high" />High</span>
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-trust-medium" />Medium</span>
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-trust-low" />Low</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ── Reusable section pieces (shared visual language with the app's About page) ── */

function SectionHeading({ overline, title, body }: { overline?: string; title: string; body?: string }): React.ReactElement {
    return (
        <div className="flex flex-col gap-3 max-w-2xl">
            {overline && (
                <span className="font-label-md text-label-md text-primary uppercase tracking-wider">{overline}</span>
            )}
            <h2 className="font-headline-lg text-headline-lg text-on-surface">{title}</h2>
            {body && <p className="font-body-lg text-body-lg text-on-surface-variant">{body}</p>}
        </div>
    );
}

function FeatureCard({ icon, title, body }: { icon: string; title: string; body: string }): React.ReactElement {
    return (
        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Icon name={icon} size={20} weight={300} className="text-primary" />
            </div>
            <h3 className="font-headline-md text-headline-md text-on-surface">{title}</h3>
            <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">{body}</p>
        </div>
    );
}

function StepRow({ number, title, body }: { number: string; title: string; body: string }): React.ReactElement {
    return (
        <div className="flex gap-4 items-start">
            <div className="w-8 h-8 shrink-0 rounded-full bg-primary flex items-center justify-center mt-0.5">
                <span className="font-label-md text-label-md text-on-primary font-semibold">{number}</span>
            </div>
            <div>
                <p className="font-body-lg text-body-lg text-on-surface font-medium">{title}</p>
                <p className="font-body-md text-body-md text-on-surface-variant mt-0.5">{body}</p>
            </div>
        </div>
    );
}

function FormatBadge({ icon, label }: { icon: string; label: string }): React.ReactElement {
    return (
        <span className="flex items-center gap-2 px-3 py-1.5 rounded-[10px] border border-outline-variant bg-surface-container font-label-md text-label-md text-on-surface-variant">
            <Icon name={icon} size={14} />
            {label}
        </span>
    );
}

/* ── Download cards ──────────────────────────────────────────────────────── */

function DownloadCard({
    icon,
    platform,
    detail,
    href,
    cta,
    note,
}: {
    icon: string;
    platform: string;
    detail: string;
    href: string;
    cta: string;
    note?: string;
}): React.ReactElement {
    const available = Boolean(href);
    return (
        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <Icon name={icon} size={20} weight={300} className="text-primary" />
                </div>
                <div>
                    <p className="font-body-lg text-body-lg text-on-surface font-medium">{platform}</p>
                    <p className="font-body-sm text-body-sm text-on-surface-variant">{detail}</p>
                </div>
            </div>
            {available ? (
                <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-full bg-primary text-on-primary font-label-md text-label-md font-semibold hover:opacity-90 transition-opacity no-underline"
                >
                    <Icon name="download" size={16} />
                    {cta}
                </a>
            ) : (
                <span className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-full border border-outline-variant bg-surface-container-high text-on-surface-variant font-label-md text-label-md font-semibold cursor-default">
                    <Icon name="schedule" size={16} />
                    Coming soon
                </span>
            )}
            {note && <p className="font-body-sm text-body-sm text-on-surface-variant">{note}</p>}
        </div>
    );
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function App(): React.ReactElement {
    // Keep the browser-tab favicon contrasting with the OS / browser theme so
    // it stays visible even when the page theme is toggled away from the system.
    React.useEffect(() => syncFaviconToSystemTheme(), []);

    return (
        <div id="top" className="relative bg-surface min-h-screen">
            {/* Atmospheric background — matches the app's Dashboard / About page. */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-primary via-transparent to-transparent" />

            <div className="relative z-10">
                <Header />

                <main className="max-w-6xl mx-auto px-5 sm:px-8 lg:px-[--spacing-margin-page]">

                    {/* ── Hero ── */}
                    <section className="py-16 sm:py-24 grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
                        <div className="flex flex-col gap-6">
                            <div>
                                <span className="px-3 py-1 rounded-full bg-primary/10 font-label-md text-label-md text-primary border border-primary/20">
                                    Free · Private · Runs offline
                                </span>
                            </div>
                            <h1 className="font-display-lg text-4xl sm:text-display-lg text-primary tracking-tight">
                                Turn document tables<br />into clean spreadsheets,<br />right on your machine.
                            </h1>
                            <p className="font-body-lg text-body-lg text-on-surface-variant max-w-xl">
                                Anchor pulls the tables out of your PDFs and photos (transcripts, invoices, statements,
                                lab results, spreadsheets locked inside a scan) and turns them into clean rows and columns
                                you can open in Excel. Everything happens on your own computer. Nothing is ever uploaded,
                                so your sensitive records stay yours alone.
                            </p>
                            <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 pt-2">
                                <a
                                    href="#download"
                                    className="flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-primary text-on-primary font-label-md text-label-md font-semibold hover:opacity-90 transition-opacity no-underline"
                                >
                                    <Icon name="download" size={18} />
                                    Download free for Windows
                                </a>
                                <a
                                    href={LINKS.github}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center justify-center gap-2 px-6 py-3 rounded-full border border-outline-variant bg-surface-container text-on-surface font-label-md text-label-md font-semibold hover:bg-surface-container-high transition-colors no-underline"
                                >
                                    <Icon name="code" size={18} weight={300} />
                                    View source
                                </a>
                            </div>
                            <p className="font-body-sm text-body-sm text-on-surface-variant">
                                Free and open source. Windows now, with macOS planned for a later release.
                            </p>
                        </div>
                        <div className="lg:pl-4">
                            <ProductPreview />
                        </div>
                    </section>

                    {/* ── Trust strip ── */}
                    <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 pb-16 sm:pb-24">
                        {[
                            { stat: '0', label: 'Files sent to the cloud' },
                            { stat: '$0', label: 'Cost to download' },
                            { stat: '100%', label: 'Runs offline on your PC' },
                            { stat: 'Excel', label: 'Export to CSV, open in Excel' },
                        ].map(({ stat, label }) => (
                            <div key={label} className="rounded-[10px] border border-outline-variant bg-surface-container p-5 text-center">
                                <p className="font-display-lg text-headline-lg text-primary">{stat}</p>
                                <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">{label}</p>
                            </div>
                        ))}
                    </section>

                    {/* ── The Problem ── */}
                    <section className="flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading
                            title="The tables you need are stuck in your documents"
                            body="The data you actually want is usually a table, trapped inside a scanned PDF, a photo of a page, or a printout that was never a spreadsheet. Getting it into rows and columns today means one of two bad options: paste it into a cloud tool that ships your private records off to someone else's servers, or retype the whole thing by hand, where one character error (a missing zero, a decimal point in the wrong place) could transform your data from millions to thousands, or dollars to cents."
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {[
                                { icon: 'cloud_off', label: 'Online tools send your private records to someone else’s servers' },
                                { icon: 'schedule', label: 'Retyping tables by hand is slow, tedious, and easy to get wrong' },
                                { icon: 'search_off', label: 'Once it’s typed up, there’s no easy way to check it against the original' },
                            ].map(({ icon, label }) => (
                                <div key={icon} className="flex gap-3 items-start rounded-[10px] border border-outline-variant bg-surface-container p-4">
                                    <Icon name={icon} size={18} weight={300} className="text-on-surface-variant shrink-0 mt-0.5" />
                                    <p className="font-body-md text-body-md text-on-surface-variant">{label}</p>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* ── Core Capabilities ── */}
                    <section id="features" className="scroll-mt-20 flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading overline="What you get" title="Built for getting tables right" />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <FeatureCard
                                icon="table_chart"
                                title="Tables become spreadsheets"
                                body="Anchor focuses on one job and does it well: reading the tables in your documents and turning them into clean rows and columns. Export to CSV — ready to open in Excel — plus Markdown, HTML, or plain text, and keep working."
                            />
                            <FeatureCard
                                icon="lock"
                                title="Completely private"
                                body="Everything runs on your own computer, with no accounts, no uploads, and no internet needed after setup. Your medical, legal, and financial records never leave your machine, so there's nothing to leak."
                            />
                            <FeatureCard
                                icon="visibility"
                                title="See where every number came from"
                                body="The original document sits right next to the extracted table. Click any cell and Anchor highlights the exact spot on the page it was read from, so checking the result against the source takes a glance, not a re-read."
                            />
                            <FeatureCard
                                icon="thermostat"
                                title="Knows what to double-check"
                                body="Every cell is color-coded green, yellow, or red for how confident Anchor is. Anything it couldn't read cleanly gets flagged, so you can fix the handful of shaky cells instead of proofreading the whole table."
                            />
                        </div>
                    </section>

                    {/* ── How It Works (friendly) ── */}
                    <section id="how" className="scroll-mt-20 flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading
                            overline="How it works"
                            title="Four steps, start to finish"
                            body="No setup, no settings to learn. Drop a file in and you'll have a spreadsheet a moment later."
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-6">
                            <StepRow number="1" title="Drop in your file" body="Add a PDF or a photo of the page: a transcript, an invoice, a statement, anything with a table on it." />
                            <StepRow number="2" title="Anchor reads the table" body="On-device AI reads the page and lays the data out into clean rows and columns. This all happens on your computer." />
                            <StepRow number="3" title="Glance and verify" body="Cells are color-coded by confidence. Click one to see exactly where it came from on the original page, and fix anything flagged." />
                            <StepRow number="4" title="Export your table" body="Save the finished table as CSV (opens right in Excel), Markdown, HTML, or plain text and carry on with your work." />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                            <div>
                                <p className="font-label-md text-label-md text-on-surface-variant mb-3 uppercase tracking-wider">Input formats</p>
                                <div className="flex flex-wrap gap-2">
                                    <FormatBadge icon="picture_as_pdf" label="PDF" />
                                    <FormatBadge icon="image" label="PNG" />
                                    <FormatBadge icon="image" label="JPEG" />
                                </div>
                            </div>
                            <div>
                                <p className="font-label-md text-label-md text-on-surface-variant mb-3 uppercase tracking-wider">Output formats</p>
                                <div className="flex flex-wrap gap-2">
                                    <FormatBadge icon="table_chart" label="CSV" />
                                    <FormatBadge icon="code" label="HTML" />
                                    <FormatBadge icon="notes" label="Markdown" />
                                    <FormatBadge icon="article" label="Plain text" />
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* ══════════════ DEEPER LOOK - technical content below ══════════════ */}
                    <section id="deep-dive" className="scroll-mt-20 pb-16 sm:pb-24">
                        <div className="rounded-[14px] border border-outline-variant bg-surface-container-low p-8 sm:p-10 flex flex-col gap-4">
                            <span className="font-label-md text-label-md text-primary uppercase tracking-wider">A deeper look</span>
                            <h2 className="font-headline-lg text-headline-lg text-on-surface max-w-2xl">
                                For the technical
                            </h2>
                            <p className="font-body-lg text-body-lg text-on-surface-variant max-w-2xl">
                                Everything above happens through a fully on-device pipeline: OCR, a local vision-language
                                model, deterministic provenance matching, and per-cell confidence scoring. Here's how the
                                internals actually work, and the stack they run on.
                            </p>
                        </div>
                    </section>

                    {/* ── Pipeline (technical) ── */}
                    <section className="flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading
                            overline="Pipeline"
                            title="From raw file to verified table"
                            body="Nine stages, all running locally, so no data ever leaves the machine."
                        />
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-5">
                            <StepRow number="1" title="Ingest & validate" body="Drop a PDF, PNG, or JPEG. Anchor validates the format and checks whether the document contains extractable content." />
                            <StepRow number="2" title="OCR" body="Files are rendered to high-resolution images (PDFs at 2000 px wide via PDFium; image uploads as-is) and passed through Tesseract for word-level text and bounding boxes." />
                            <StepRow number="3" title="OCR image preprocessing" body="A separate copy is prepared just for Tesseract: grayscaled and, for small uploads, upscaled with Lanczos resampling. The original image is untouched, so click-to-highlight boxes always land on the right spot." />
                            <StepRow number="4" title="Context assembly" body="OCR words are sanitized and sorted into reading order. Two views are built from the same word array: spatially-aligned text for the AI, and an indexed word list with bounding boxes for provenance." />
                            <StepRow number="5" title="Stage 1: AI extraction" body="The local vision-language model reads the image alongside the spatial OCR text and emits a clean table with greedy decoding. Token log-probabilities are captured during streaming." />
                            <StepRow number="6" title="Stage 2: Provenance matching" body="A deterministic algorithm walks the cells and OCR words in parallel. Each cell is linked to its source word. Even when dozens share identical values, sequence position disambiguates them." />
                            <StepRow number="7" title="Confidence scoring" body="Three signals per cell (AI log-probability as mean and minimum, OCR word confidence, and source agreement) blend into a trust level that drives the color heatmap." />
                            <StepRow number="8" title="Human verification" body="The table color-codes every cell by trust. Click a cell to highlight its source region; cells with no OCR match get an unverified badge, and approximate matches a lowered-confidence badge." />
                            <StepRow number="9" title="Export" body="Save verified data as CSV, HTML, Markdown, or plain text. The model is unloaded from RAM once it's been idle to free resources." />
                        </div>
                    </section>

                    {/* ── How confidence & provenance work (technical) ── */}
                    <section className="flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading overline="Trust signals" title="How the heatmap is computed" />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <FeatureCard
                                icon="thermostat"
                                title="Per-cell confidence scoring"
                                body="Every extracted cell is color-coded green, yellow, or red based on a blend of AI token log-probability and Tesseract OCR word confidence. The minimum token probability is tracked separately to catch a single shaky digit hiding inside an otherwise confident number."
                            />
                            <FeatureCard
                                icon="account_tree"
                                title="Deterministic source matching"
                                body="A code-based reading-order walk links each extracted cell back to the OCR words it came from, with no extra model tokens and no latency. A fuzzy second pass recovers single-character OCR misreads and flags them as approximate so you know exactly what to double-check."
                            />
                        </div>
                    </section>

                    {/* ── Under the hood ── */}
                    <section id="tech" className="scroll-mt-20 flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading overline="Architecture" title="Under the hood" />
                        <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                            {[
                                { label: 'Interface', value: 'React + TypeScript', note: 'Type-safe, high-interactivity UI' },
                                { label: 'Framework', value: 'Tauri', note: 'Lightweight native desktop shell with lower overhead than Electron' },
                                { label: 'AI runtime', value: 'llama.cpp server', note: 'Model-agnostic inference; swap models without rebuilding' },
                                { label: 'Vision model', value: 'Qwen3.5-4b (multimodal)', note: 'Handles vision tasks and OCR validation locally' },
                                { label: 'OCR engine', value: 'Tesseract', note: 'Word-level bounding boxes and per-character confidence' },
                                { label: 'Image preprocessing', value: 'image (Rust)', note: 'Grayscale + Lanczos upscaling before OCR, with no system OpenCV dependency' },
                                { label: 'PDF rendering', value: 'PDFium', note: 'High-fidelity 2000px renders from native PDF pages' },
                                { label: 'Storage', value: 'SQLite (local)', note: 'Session and file metadata stored entirely on-device' },
                            ].map(({ label, value, note }) => (
                                <div key={label} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 px-5 py-4">
                                    <p className="font-label-md text-label-md text-on-surface-variant sm:w-32 sm:shrink-0 sm:mt-0.5">{label}</p>
                                    <div>
                                        <p className="font-body-md text-body-md text-on-surface font-medium">{value}</p>
                                        <p className="font-body-sm text-body-sm text-on-surface-variant">{note}</p>
                                    </div>
                                </div>
                            ))}
                        </div>

                    </section>

                    {/* ── Hardware ── */}
                    <section className="flex flex-col gap-6 pb-16 sm:pb-24">
                        <SectionHeading overline="Adaptive" title="Adapts to your hardware" />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
                                <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">GPU acceleration</p>
                                <h3 className="font-headline-md text-headline-md text-on-surface">Automatic detection</h3>
                                <p className="font-body-md text-body-md text-on-surface-variant">
                                    On first run, Anchor detects your graphics card and downloads the matching
                                    accelerated build — NVIDIA (CUDA), AMD (ROCm), or Apple Silicon (Metal).
                                </p>
                            </div>
                            <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
                                <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">CPU fallback</p>
                                <h3 className="font-headline-md text-headline-md text-on-surface">Runs on any machine</h3>
                                <p className="font-body-md text-body-md text-on-surface-variant">
                                    No GPU required — Anchor runs the full pipeline on your CPU, and a GPU build
                                    automatically falls back to CPU if acceleration can't initialize.
                                </p>
                            </div>
                        </div>
                        <p className="font-body-md text-body-md text-on-surface-variant max-w-2xl">
                            The installer is small; the AI model and platform binaries (~3.5 GB) are downloaded
                            once on first launch and SHA-256 verified.
                        </p>
                    </section>

                    {/* ── Download ── */}
                    <section id="download" className="scroll-mt-20 flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading
                            overline="Get started"
                            title="Download Anchor"
                            body="A small installer pulls the rest on first launch. No account, no sign-in, just install and start extracting."
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <DownloadCard
                                icon="window"
                                platform="Windows"
                                detail="Windows 10 / 11 · 64-bit"
                                href={LINKS.releases}
                                cta="Download installer"
                                note="Signed installer via GitHub Releases."
                            />
                            <DownloadCard
                                icon="storefront"
                                platform="Microsoft Store"
                                detail="One-click install · auto-update"
                                href={LINKS.microsoftStore}
                                cta="Get from Store"
                                note="Coming with the Store listing."
                            />
                            <DownloadCard
                                icon="laptop_mac"
                                platform="macOS"
                                detail="Apple Silicon · notarized DMG"
                                href={LINKS.macDownload}
                                cta="Download DMG"
                                note="Planned in a later release."
                            />
                        </div>
                        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6">
                            <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-4">System requirements</p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-y-3 gap-x-6">
                                {[
                                    { icon: 'memory', label: '8 GB RAM minimum' },
                                    { icon: 'hard_drive', label: '~4 GB free disk for models' },
                                    { icon: 'wifi', label: 'Internet for first-run setup only' },
                                    { icon: 'developer_board', label: 'Optional NVIDIA, AMD, or Apple Silicon GPU acceleration' },
                                    { icon: 'lock', label: 'Runs fully offline after setup' },
                                    { icon: 'verified_user', label: 'All downloads SHA-256 verified' },
                                ].map(({ icon, label }) => (
                                    <div key={label} className="flex items-center gap-2.5">
                                        <Icon name={icon} size={18} weight={300} className="text-primary shrink-0" />
                                        <span className="font-body-md text-body-md text-on-surface-variant">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </section>
                </main>

                {/* ── Footer ── */}
                <footer className="border-t border-outline-variant">
                    <div className="max-w-6xl mx-auto px-5 sm:px-8 lg:px-[--spacing-margin-page] py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-2 text-on-surface-variant">
                            <AnchorMark className="w-6 h-6 rounded-md" />
                            <span className="font-body-md text-body-md">Anchor · local-first AI data extraction</span>
                        </div>
                        <div className="flex items-center gap-5 font-label-md text-label-md text-on-surface-variant">
                            <a href={LINKS.github} target="_blank" rel="noreferrer" className="hover:text-on-surface transition-colors no-underline">GitHub</a>
                            <a href={LINKS.releases} target="_blank" rel="noreferrer" className="hover:text-on-surface transition-colors no-underline">Releases</a>
                            <a href="#download" className="hover:text-on-surface transition-colors no-underline">Download</a>
                        </div>
                    </div>
                </footer>
            </div>
        </div>
    );
}
