import React from 'react';
import Icon from './components/Icon';
import AnchorMark from './components/AnchorMark';
import { syncFaviconToSystemTheme } from './favicon';
import { copyrightYears } from './copyright';

/* ─────────────────────────────────────────────────────────────────────────
   Project links. These are the only values you'll likely need to edit before
   publishing — kept together so they're easy to find and swap.
   ───────────────────────────────────────────────────────────────────────── */
const LINKS = {
    /** Public repository. */
    github: 'https://github.com/apalecz2/anchor',
    /** GitHub Releases page (docs/release.md §2). Used directly for the footer
     *  "Releases" link; the Download cards prefer a direct asset URL resolved
     *  by useLatestReleaseAssets and fall back to this page only if that
     *  resolution fails (offline, rate-limited, asset renamed). */
    releases: 'https://github.com/apalecz2/anchor/releases/latest',
    /** Microsoft Store listing, planned (docs/release.md §6). Leave empty until live. */
    microsoftStore: '',
    /** macOS DMG fallback — same caveat as `releases` above. The .app itself is
     *  a universal build, but the AI runtime it downloads on first launch
     *  (llama-server, PDFium) is Apple Silicon-only (see paths.rs::pdfium_spec /
     *  setup.rs::get_llama_server_spec) — it does not actually run on Intel Macs.
     *  Unsigned for now. */
    macDownload: 'https://github.com/apalecz2/anchor/releases/latest',
};

const NAV = [
    { href: '#features', label: 'Features' },
    { href: '#how', label: 'How it works' },
    { href: '#deep-dive', label: 'Architecture' },
    { href: '#download', label: 'Download' },
];

/* ── Direct-download resolution ──────────────────────────────────────────── */

/** GitHub Releases asset the Windows/macOS download cards should link to
 * straight-away, resolved from the latest release. `null` means "not
 * resolved yet (or resolution failed)" — callers fall back to LINKS.releases
 * / LINKS.macDownload, which must always remain a working path to a
 * download, since this fetch can fail (offline, rate-limited, CORS). */
interface ReleaseAssetLinks {
    windows: string | null;
    mac: string | null;
}

const RELEASE_API_URL = 'https://api.github.com/repos/apalecz2/anchor/releases/latest';
// Release filenames embed the version (e.g. Anchor_0.3.0_x64-setup.exe), so
// there's no fixed asset name to link to directly — match by stable suffix
// instead. Both are unique within a release (one NSIS installer, one dmg).
const WINDOWS_ASSET_SUFFIX = 'x64-setup.exe';
const MAC_ASSET_SUFFIX = '.dmg';

// Cache the resolved links so a repeat visit doesn't re-hit the GitHub API
// (anonymous requests are rate-limited to 60/hr per IP, shared across every
// visitor behind the same NAT) and so navigating within the page doesn't
// re-fetch. An hour is generous next to how often releases actually ship.
const CACHE_KEY = 'anchor:latestReleaseAssets';
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CachedReleaseAssets extends ReleaseAssetLinks {
    fetchedAt: number;
}

function readReleaseAssetCache(): ReleaseAssetLinks | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw) as CachedReleaseAssets;
        if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
        return { windows: cached.windows, mac: cached.mac };
    } catch {
        // Corrupt cache entry or localStorage unavailable (private browsing) —
        // treat as a miss and re-resolve.
        return null;
    }
}

function writeReleaseAssetCache(links: ReleaseAssetLinks): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ ...links, fetchedAt: Date.now() } satisfies CachedReleaseAssets));
    } catch {
        // Quota exceeded or unavailable — non-fatal, just skip caching.
    }
}

/** Resolves the current release's installer URLs so the Download cards can
 * skip the GitHub releases page and hand the browser a file directly. Reads
 * a cached result first; otherwise hits the GitHub API once on mount. Never
 * the only path to a download — see ReleaseAssetLinks above. */
function useLatestReleaseAssets(): ReleaseAssetLinks {
    const [links, setLinks] = React.useState<ReleaseAssetLinks>(() => readReleaseAssetCache() ?? { windows: null, mac: null });

    React.useEffect(() => {
        if (readReleaseAssetCache()) return; // state already seeded from cache above

        let cancelled = false;
        fetch(RELEASE_API_URL, { headers: { Accept: 'application/vnd.github+json' } })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`GitHub API responded ${res.status}`))))
            .then((release: { assets?: { name: string; browser_download_url: string }[] }) => {
                if (cancelled) return;
                const assets = release.assets ?? [];
                const resolved: ReleaseAssetLinks = {
                    windows: assets.find((a) => a.name.endsWith(WINDOWS_ASSET_SUFFIX))?.browser_download_url ?? null,
                    mac: assets.find((a) => a.name.endsWith(MAC_ASSET_SUFFIX))?.browser_download_url ?? null,
                };
                setLinks(resolved);
                writeReleaseAssetCache(resolved);
            })
            .catch(() => {
                // Network error, rate limit, or an unexpected response shape —
                // leave links null so callers keep pointing at the releases page.
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return links;
}

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
                <nav className="hidden lg:flex items-center gap-1">
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
                        className="lg:hidden w-9 h-9 rounded-full border border-outline-variant bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
                    >
                        <Icon name={menuOpen ? 'close' : 'menu'} size={20} weight={300} />
                    </button>
                </div>
            </div>

            {/* Mobile dropdown nav — replaces the desktop links below the lg breakpoint,
                since the four labels start wrapping onto two lines before there's
                enough room for them to sit comfortably on one row. */}
            {menuOpen && (
                <nav className="lg:hidden border-t border-outline-variant bg-surface px-5 py-3 flex flex-col gap-1">
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

type Trust = 'high' | 'medium' | 'low';
interface PreviewCell {
    value: string;
    trust: Trust;
    /** '≈' mirrors ProvenanceTable's fuzzy-match badge. */
    badge?: '≈';
}

// Stand-in confidence percentages driving the hue math below — not shown to
// the visitor, just picked so high/medium/low land clearly in each band.
const TRUST_CONFIDENCE: Record<Trust, number> = { high: 96, medium: 74, low: 38 };

// Exactly DocumentViewer's getConfidenceColor (app/src/components/DocumentViewer.tsx):
// 0% confidence -> red, 100% -> green, same hue/saturation/lightness.
const wordHue = (trust: Trust) => (TRUST_CONFIDENCE[trust] / 100) * 120;

// Exactly ProvenanceTable's TRUST_BG / TRUST_TEXT (app/src/components/ProvenanceTable.tsx),
// so the heatmap on this card uses the identical palette as the real output table.
const CELL_BG: Record<Trust, string> = {
    high: 'bg-green-100 dark:bg-green-500/15',
    medium: 'bg-amber-100 dark:bg-amber-500/15',
    low: 'bg-red-100 dark:bg-red-500/15',
};
const CELL_TEXT: Record<Trust, string> = {
    high: 'text-green-900 dark:text-green-200',
    medium: 'text-amber-900 dark:text-amber-200',
    low: 'text-red-900 dark:text-red-200',
};

// A cell's OCR words don't all necessarily share the cell's overall trust — a
// cell can combine a clean word with a misread one. "11O" (letter O, an OCR
// misread of "110") is the one word actually responsible for the low-trust
// cell it belongs to; every other word in these rows reads cleanly, matching
// its cell's trust. This mirrors the real pipeline: confidence is scored per
// word first, and a cell's trust reflects the shakiest word inside it.
const WORD_TRUST_OVERRIDE: Record<string, Trust> = { HIST: 'high', '11O': 'low' };

// Shared by both panes so the source document and the extracted table always
// show identical column labels. Header cells carry their own OCR confidence
// too, exactly like ProvenanceTable's headerClasses — a header is read off the
// page the same as any other word, so it gets the same trust treatment.
const COLUMNS: { label: string; trust: Trust }[] = [
    { label: 'Code', trust: 'high' },
    { label: 'Course', trust: 'high' },
    { label: 'Cr', trust: 'medium' },
];

function ProductPreview(): React.ReactElement {
    const rows: PreviewCell[][] = [
        [{ value: 'CHEM 101', trust: 'high' }, { value: 'Intro Chemistry', trust: 'high' }, { value: '3.0', trust: 'high' }],
        [{ value: 'MATH 204', trust: 'high' }, { value: 'Linear Algebra', trust: 'medium' }, { value: '4.0', trust: 'high' }],
        [{ value: 'HIST 11O', trust: 'low', badge: '≈' }, { value: 'World History', trust: 'high' }, { value: '3.0', trust: 'medium' }],
        [{ value: 'BIOL 150', trust: 'high' }, { value: 'Cell Biology', trust: 'high' }, { value: '4.0', trust: 'high' }],
    ];

    return (
        <div className="rounded-[14px] border border-outline-variant bg-surface-container-low overflow-hidden shadow-2xl shadow-black/10">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-4 h-10 border-b border-outline-variant bg-surface-container">
                <span className="w-3 h-3 rounded-full bg-outline-variant" />
                <span className="w-3 h-3 rounded-full bg-outline-variant" />
                <span className="w-3 h-3 rounded-full bg-outline-variant" />
                <span className="ml-3 font-body-sm text-body-sm text-on-surface-variant">Anchor</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-outline-variant">
                {/* Source document pane: mirrors DocumentViewer + SourceDocumentPane —
                    a page image with a translucent, colored box drawn over every OCR
                    word (color by confidence), plus the floating draw/pan/zoom pill
                    docked at the bottom of the pane. */}
                <div className="relative p-5 pb-14 bg-surface-bright">
                    <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-3">Source</p>
                    {/* Stands in for the page image itself — DocumentViewer renders the
                        actual document in a shadowed rectangle sitting on the pane
                        background (app/src/components/DocumentViewer.tsx); the word boxes
                        below are the OCR overlay layered on top of it. */}
                    <div className="rounded-sm bg-surface-container-lowest p-3 shadow-sm shadow-black/10">
                        {/* Same column labels as the extracted table below, so the two
                            panes visibly describe the same document — headers are OCR
                            words too, so they get the same confidence box as any other. */}
                        <div className="grid grid-cols-[1fr_1.4fr_0.5fr] gap-x-2 border-b border-outline-variant pb-2 font-mono-data text-[11px] font-semibold leading-tight">
                            {COLUMNS.map(({ label, trust }) => {
                                const hue = wordHue(trust);
                                return (
                                    <span
                                        key={label}
                                        className="inline-block w-fit rounded-xs px-1 leading-snug text-on-surface"
                                        style={{
                                            backgroundColor: `hsla(${hue}, 80%, 45%, 0.3)`,
                                            boxShadow: `inset 0 0 0 1px hsl(${hue}, 80%, 45%)`,
                                        }}
                                    >
                                        {label}
                                    </span>
                                );
                            })}
                        </div>
                        <div className="mt-3 grid grid-cols-[1fr_1.4fr_0.5fr] gap-x-2 gap-y-2 font-mono-data text-[11px] leading-tight">
                            {rows.map((cells, ri) => (
                                <React.Fragment key={ri}>
                                    {cells.map((cell, ci) => (
                                        <div key={ci} className="flex flex-wrap items-start gap-1">
                                            {cell.value.split(' ').map((word, wi) => {
                                                const hue = wordHue(WORD_TRUST_OVERRIDE[word] ?? cell.trust);
                                                return (
                                                    <span
                                                        key={wi}
                                                        className="inline-block rounded-xs px-1 leading-snug text-on-surface"
                                                        style={{
                                                            backgroundColor: `hsla(${hue}, 80%, 45%, 0.3)`,
                                                            boxShadow: `inset 0 0 0 1px hsl(${hue}, 80%, 45%)`,
                                                        }}
                                                    >
                                                        {word}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    ))}
                                </React.Fragment>
                            ))}
                        </div>
                    </div>

                    {/* Floating tool pill — decorative stand-in for the real bottom-docked
                        draw/pan/overlay/zoom toolbar in SourceDocumentPane. */}
                    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                        <div className="flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface/95 backdrop-blur-sm shadow-lg px-2 py-1">
                            <Icon name="draw" size={13} weight={300} className="text-primary" />
                            <Icon name="pan_tool" size={13} weight={300} className="text-on-surface-variant" />
                            <span className="mx-0.5 h-3 w-px bg-outline-variant" />
                            <Icon name="zoom_in" size={13} weight={300} className="text-on-surface-variant" />
                            <span className="font-body-sm text-[10px] tabular-nums text-on-surface-variant">100%</span>
                        </div>
                    </div>
                </div>

                {/* Extracted table pane: mirrors ProvenanceTable — bordered grid cells
                    with a full pastel background tint by trust level (not just a
                    colored marker) and the same fuzzy-match badge glyph. */}
                <div className="p-5">
                    <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-3">Extracted · confidence heatmap</p>
                    {/* overflow-x-auto + browser auto table layout mirrors ProvenanceTable
                        exactly: columns size to their content instead of a forced split,
                        so short/long values both stay on one line and legible. */}
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse font-mono-data text-[11px] leading-tight">
                            <thead>
                                <tr>
                                    {COLUMNS.map(({ label, trust }) => (
                                        <th
                                            key={label}
                                            className={`whitespace-nowrap border border-outline-variant border-b-2 border-b-on-surface/30 px-1 py-1.5 text-left font-semibold ${CELL_BG[trust]} ${CELL_TEXT[trust]}`}
                                        >
                                            {label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((cells, ri) => (
                                    <tr key={ri}>
                                        {cells.map((cell, ci) => (
                                            <td
                                                key={ci}
                                                className={`whitespace-nowrap border border-outline-variant px-1 py-1.5 ${CELL_BG[cell.trust]} ${CELL_TEXT[cell.trust]}`}
                                            >
                                                <div className="flex items-center gap-1">
                                                    <span>{cell.value}</span>
                                                    {cell.badge && (
                                                        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-surface-variant text-[9px] font-medium leading-none text-on-surface-variant">
                                                            {cell.badge}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
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
                <h3 className="font-body-lg text-body-lg text-on-surface font-medium">{title}</h3>
                <p className="font-body-md text-body-md text-on-surface-variant mt-0.5">{body}</p>
            </div>
        </div>
    );
}

// Swaps the hero CTA's platform name to match the visitor's OS, so a macOS
// visitor isn't told (as the most prominent instruction on the page) to grab
// a Windows build. Read once via userAgent — lazy useState initializer, same
// pattern as useIsDesktop below — since this is a browser-only SPA with no
// SSR pass to worry about.
function usePlatformLabel(): string | null {
    return React.useState<string | null>(() => {
        const ua = window.navigator.userAgent;
        if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
        if (/Windows/.test(ua)) return 'Windows';
        return null;
    })[0];
}

// Tracks the `lg` breakpoint (1024px) that the pipeline grid below switches to
// two columns at. Read live via matchMedia (same pattern as ThemeToggle's OS-theme
// listener) rather than CSS alone, because PipelineStep needs to pick between two
// structurally different elements (a plain row vs. a <details> disclosure) rather
// than just restyling one.
function useIsDesktop(): boolean {
    const [isDesktop, setIsDesktop] = React.useState(() => window.matchMedia('(min-width: 1024px)').matches);
    React.useEffect(() => {
        const mq = window.matchMedia('(min-width: 1024px)');
        const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);
    return isDesktop;
}

// Same numbered-row layout as StepRow, but on small screens the body collapses
// behind a native <details> disclosure. Used for the ten-stage pipeline list,
// which is long enough on a single-column mobile layout that showing every
// stage's full description at once makes the section hard to scan. Above the
// `lg` breakpoint the grid goes two columns and there's no need to hide
// anything, so it renders as a plain always-expanded row with no toggle.
function PipelineStep({ number, title, body }: { number: string; title: string; body: string }): React.ReactElement {
    const isDesktop = useIsDesktop();

    if (isDesktop) {
        return <StepRow number={number} title={title} body={body} />;
    }

    return (
        <details className="group">
            <summary className="flex gap-4 items-start cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <div className="w-8 h-8 shrink-0 rounded-full bg-primary flex items-center justify-center mt-0.5">
                    <span className="font-label-md text-label-md text-on-primary font-semibold">{number}</span>
                </div>
                <div className="flex-1 flex items-center justify-between gap-3 mt-0.5">
                    <h3 className="font-body-lg text-body-lg text-on-surface font-medium">{title}</h3>
                    <Icon
                        name="expand_more"
                        size={20}
                        weight={300}
                        className="text-on-surface-variant shrink-0 transition-transform duration-200 group-open:rotate-180"
                    />
                </div>
            </summary>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1 pl-12">{body}</p>
        </details>
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
    direct = false,
}: {
    icon: string;
    platform: string;
    detail: string;
    href: string;
    cta: string;
    note?: string;
    /** True once href points straight at a GitHub release asset (resolved by
     * useLatestReleaseAssets) rather than the releases page — GitHub serves
     * those with Content-Disposition: attachment, so the click downloads the
     * file in place. target="_blank" is only needed for the page-link
     * fallback; on a direct asset it just risks a flashed blank tab. */
    direct?: boolean;
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
                    {...(direct ? {} : { target: '_blank', rel: 'noreferrer' })}
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

/* ── Ambient background ──────────────────────────────────────────────────── */

type Blob = { top: number; left: number; size: number; duration: number; delay: number; peak: number };

/** Randomized once per page load so blobs land in different spots each visit.
 * Positions come from a grid of cells covering the full page (rows down the
 * page, columns across it) with each blob centred in its cell and jittered.
 *
 * The plain grid alone banded blobs into fixed vertical columns: with one blob
 * per cell, every column ended up with a blob at each row height, so they read
 * as stacks marching straight down the page (the jitter was too small next to
 * the blob size to hide it). To break that, every *row* gets its own random
 * horizontal phase, sliding the whole row sideways — so no two rows share a
 * vertical band and the columns dissolve, while blobs stay evenly spaced
 * across each row. left/top are the blob *centre* (see AmbientBlobs for why
 * that matters and how it's offset). Mobile gets fewer, smaller blobs and only
 * two columns so the backdrop doesn't feel cluttered on a small screen. */
function useRandomBlobs(): Blob[] {
    return React.useState<Blob[]>(() => {
        const mobile = window.matchMedia('(max-width: 640px)').matches;
        const count = mobile ? 4 : 9;
        const cols = mobile ? 2 : 3;
        const rows = Math.ceil(count / cols);
        const [minSize, sizeRange] = mobile ? [160, 100] : [260, 220];
        const colWidth = 100 / cols;
        const rowHeight = 100 / rows;
        // One random sideways shift per row (up to ±40% of a column). This is
        // what staggers the rows out of alignment; per-blob jitter on top adds
        // the finer randomness.
        const rowPhase = Array.from({ length: rows }, () => (Math.random() - 0.5) * 0.8 * colWidth);
        return Array.from({ length: count }, (_, i) => {
            const row = Math.floor(i / cols);
            const col = i % cols;
            return {
                left: (col + 0.5) * colWidth + rowPhase[row] + (Math.random() - 0.5) * 0.5 * colWidth,
                top: (row + 0.5) * rowHeight + (Math.random() - 0.5) * 0.6 * rowHeight,
                size: minSize + Math.random() * sizeRange,
                duration: 22 + Math.random() * 16,
                delay: -Math.random() * 24,
                // Kept low (and capped well under 1) so text laid over a blob at
                // its brightest moment is still always clearly readable.
                peak: 0.06 + Math.random() * 0.06,
            };
        });
    })[0];
}

/** Patches of the minimalistic grid, monochrome (flips with dark mode), that
 * softly fade in and out at random spots — each one revealed through a soft
 * circular mask that feathers the grid out at its edge — so the backdrop
 * reads as alive without drawing the eye or affecting layout.
 *
 * top/left place the blob's *centre*, then a negative margin of half its size
 * pulls it back onto that point. That keeps blobs in the edge columns actually
 * on screen instead of anchoring their top-left corner near the page edge and
 * letting the (large) rest of the blob bleed off and get clipped away. A
 * transform would centre it too, but it must be a margin: a transform makes
 * the element its own containing block, which breaks background-attachment:
 * fixed and desyncs the grid phase from the other blobs. */
function AmbientBlobs(): React.ReactElement {
    const blobs = useRandomBlobs();
    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
            {blobs.map((b, i) => (
                <span
                    key={i}
                    className="ambient-grid-blob animate-blob-fade"
                    style={
                        {
                            top: `${b.top}%`,
                            left: `${b.left}%`,
                            width: b.size,
                            height: b.size,
                            marginTop: -b.size / 2,
                            marginLeft: -b.size / 2,
                            animationDuration: `${b.duration}s`,
                            animationDelay: `${b.delay}s`,
                            '--blob-peak': b.peak,
                        } as React.CSSProperties
                    }
                />
            ))}
        </div>
    );
}

const CURSOR_BLOB_SIZE = 320;

/** A grid patch that follows the mouse. The element covers the whole
 * viewport and never moves; only its mask-position shifts, so the grid lines
 * stay put and just the visible window changes. Mouse coordinates are only
 * ever written into a ref — the mask-position DOM write happens once per
 * animation frame (single-flight rAF) so it tracks the cursor as smoothly as
 * the display can paint, with no React re-renders in between. Skipped
 * entirely for touch devices (no persistent cursor) and reduced-motion
 * users. */
function CursorGridBlob(): React.ReactElement {
    const ref = React.useRef<HTMLSpanElement>(null);

    React.useEffect(() => {
        if (
            !window.matchMedia('(pointer: fine)').matches ||
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ) {
            return;
        }
        const el = ref.current;
        if (!el) return;

        const visible = 'calc(var(--blob-peak) * var(--blob-boost, 1))';
        let frame = 0;
        let x = 0;
        let y = 0;

        const applyPosition = () => {
            frame = 0;
            const pos = `${x - CURSOR_BLOB_SIZE / 2}px ${y - CURSOR_BLOB_SIZE / 2}px`;
            el.style.maskPosition = pos;
            el.style.setProperty('-webkit-mask-position', pos);
        };
        const onMove = (e: MouseEvent) => {
            x = e.clientX;
            y = e.clientY;
            el.style.opacity = visible;
            if (!frame) frame = requestAnimationFrame(applyPosition);
        };
        const onLeave = () => {
            el.style.opacity = '0';
        };
        window.addEventListener('mousemove', onMove);
        document.documentElement.addEventListener('mouseleave', onLeave);
        return () => {
            window.removeEventListener('mousemove', onMove);
            document.documentElement.removeEventListener('mouseleave', onLeave);
            if (frame) cancelAnimationFrame(frame);
        };
    }, []);

    return (
        <span
            ref={ref}
            aria-hidden="true"
            className="ambient-grid-blob cursor-grid-blob"
            style={{ '--blob-peak': 0.1, '--cursor-size': `${CURSOR_BLOB_SIZE}px` } as React.CSSProperties}
        />
    );
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function App(): React.ReactElement {
    // Keep the browser-tab favicon contrasting with the OS / browser theme so
    // it stays visible even when the page theme is toggled away from the system.
    React.useEffect(() => syncFaviconToSystemTheme(), []);
    const platform = usePlatformLabel();
    const releaseAssets = useLatestReleaseAssets();

    return (
        <div id="top" className="relative bg-surface min-h-screen">
            {/* Atmospheric background — matches the app's Dashboard / About page. */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-primary via-transparent to-transparent" />
            <AmbientBlobs />
            <CursorGridBlob />

            <div className="relative z-10">
                <Header />

                {/* ── Beta notice ── */}
                {/* Glassy like the header (backdrop-blur) so the ambient/cursor
                    grid effect reads softly *under* the strip instead of bleeding
                    through it — keeps the top chrome visually continuous. */}
                <div className="border-b border-primary/20 bg-primary/10 backdrop-blur-md">
                    <div className="max-w-6xl mx-auto px-5 sm:px-8 lg:px-[--spacing-margin-page] py-2.5 flex items-center justify-center gap-2.5 text-center">
                        <Icon name="construction" size={18} weight={300} className="text-primary shrink-0" />
                        <p className="font-body-sm text-body-sm text-on-surface-variant">
                            <span className="text-on-surface font-medium">Anchor is in beta.</span>{' '}
                            Features may still change.
                        </p>
                    </div>
                </div>

                <main className="max-w-6xl mx-auto px-5 sm:px-8 lg:px-[--spacing-margin-page]">

                    {/* ── Hero ── */}
                    <section className="py-16 sm:py-24 grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
                        <div className="flex flex-col gap-6">
                            <div>
                                <span className="px-3 py-1 rounded-full bg-primary/10 backdrop-blur-md font-label-md text-label-md text-primary border border-primary/20">
                                    Free · Private · Offline after setup
                                </span>
                            </div>
                            <h1 className="font-display-lg text-4xl sm:text-display-lg text-primary tracking-tight">
                                Turn document tables<br />into clean spreadsheets,<br />right on your machine.
                            </h1>
                            <p className="font-body-lg text-body-lg text-on-surface-variant max-w-xl">
                                Anchor pulls the tables out of your PDFs and photos (transcripts, invoices, statements,
                                lab results) and turns them into rows and columns you can open in Excel or Google Sheets.
                                Nothing is uploaded, so sensitive records stay on your machine.
                            </p>
                            <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 pt-2">
                                <a
                                    href="#download"
                                    className="flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-primary text-on-primary font-label-md text-label-md font-semibold hover:opacity-90 transition-opacity no-underline"
                                >
                                    <Icon name="download" size={18} />
                                    Get Anchor free{platform ? ` for ${platform}` : ''}
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
                                Free and source-available. Pre-release builds available now for Windows and macOS.
                            </p>
                        </div>
                        <div className="lg:pl-4">
                            <ProductPreview />
                            <p className="mt-2 text-center font-body-sm text-[11px] text-on-surface-variant/60">
                                Stylized mock, not a screenshot. Real screenshots are on{' '}
                                <a href={LINKS.github} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-on-surface-variant">
                                    GitHub
                                </a>.
                            </p>
                        </div>
                    </section>

                    {/* ── Trust strip ── */}
                    <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 pb-16 sm:pb-24">
                        {[
                            { stat: '0', label: 'Files sent to the cloud' },
                            { stat: '$0', label: 'Cost to download' },
                            { stat: '100%', label: 'Runs offline after setup' },
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
                            body="The data you actually want is usually a table, trapped inside a scanned PDF, a photo of a page, or a printout that was never a spreadsheet. Retyped by hand, one slipped keystroke (a missing zero, a decimal point in the wrong place) can turn a million-dollar figure into a thousand-dollar one, or a dollar amount into pennies."
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {[
                                { icon: 'cloud_off', label: "Online tools send your private records to someone else's servers" },
                                { icon: 'schedule', label: 'Retyping tables by hand is slow, tedious, and easy to get wrong' },
                                { icon: 'search_off', label: "Once it's typed up, there's no easy way to check it against the original" },
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
                                body="Anchor reads the tables in your documents and turns them into rows and columns. Export straight to Excel or CSV, plus Markdown, HTML, or plain text."
                            />
                            <FeatureCard
                                icon="lock"
                                title="Completely private"
                                body="Everything runs on your own computer, with no accounts, no uploads, no telemetry, and no internet needed after setup. Your medical, legal, and financial records stay under your control the whole time."
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
                            body="No setup. Drop a file in and you'll have a spreadsheet a moment later."
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-6">
                            <StepRow number="1" title="Drop in your file" body="Add a PDF or a photo of the page: a transcript, an invoice, a statement, anything with a table on it." />
                            <StepRow number="2" title="Anchor reads the table" body="On-device AI reads the page and lays the data out into rows and columns." />
                            <StepRow number="3" title="Glance and verify" body="Click any flagged cell to jump straight to its source on the page and fix it in seconds." />
                            <StepRow number="4" title="Export your table" body="Save the finished table as Excel, CSV, Markdown, HTML, or plain text." />
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
                                    <FormatBadge icon="table_chart" label="Excel" />
                                    <FormatBadge icon="table_view" label="CSV" />
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
                            <span className="font-label-md text-label-md text-primary uppercase tracking-wider">Architecture</span>
                            <h2 className="font-headline-lg text-headline-lg text-on-surface max-w-2xl">
                                For the technical
                            </h2>
                            <p className="font-body-lg text-body-lg text-on-surface-variant max-w-2xl">
                                Everything above happens through a fully on-device pipeline: OCR, a local vision-language
                                model, deterministic provenance matching, and per-cell confidence scoring. Here's how the
                                internals work, and the stack they run on.
                            </p>
                        </div>
                    </section>

                    {/* ── Pipeline (technical) ── */}
                    <section className="flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading
                            overline="Pipeline"
                            title="From raw file to verified table"
                            body="Ten stages, all running locally, so no data ever leaves the machine."
                        />
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-3">
                            <PipelineStep number="1" title="Ingest & validate" body="Drop a PDF, PNG, or JPEG. Anchor validates the format and checks whether the document contains extractable content." />
                            <PipelineStep number="2" title="OCR" body="Files are rendered to high-resolution images (PDFs rendered with PDFium) and passed through Tesseract for word-level text and bounding boxes." />
                            <PipelineStep number="3" title="OCR image preprocessing" body="A separate copy is prepared just for Tesseract: grayscaled and, for small uploads, upscaled with Lanczos resampling. The original image is untouched, so click-to-highlight boxes always land on the right spot." />
                            <PipelineStep number="4" title="Context assembly" body="OCR words are sanitized and sorted into reading order. Two views are built from the same word array: spatially-aligned text for the AI, and an indexed word list with bounding boxes for provenance." />
                            <PipelineStep number="5" title="AI extraction" body="The local vision-language model reads the image alongside the spatial OCR text and emits a table with greedy decoding. Token log-probabilities are captured during streaming." />
                            <PipelineStep number="6" title="Grid matching" body="Anchor detects the table's column and row layout from the OCR word positions, then links each cell to its source word within that exact row and column, with no extra model tokens or added latency. Duplicate values are placed correctly by position instead of guesswork." />
                            <PipelineStep number="7" title="Fallback matching" body="Any cell the grid pass couldn't place is recovered with a reading-order walk, fuzzy text matching, and spatial checks. A final pass compares blank cells against leftover OCR text so dropped content still gets flagged." />
                            <PipelineStep number="8" title="Confidence scoring" body="Three signals per cell (AI log-probability as mean and minimum, OCR word confidence, and source agreement) blend into a trust level that drives the color heatmap; a disagreement between the AI and OCR always pulls a cell down to low trust." />
                            <PipelineStep number="9" title="Human verification" body="The table color-codes every cell by trust. Click a cell to highlight its source region; cells with no OCR match get an unverified badge, and approximate matches get a lowered-confidence badge." />
                            <PipelineStep number="10" title="Export" body="Save verified data as Excel, CSV, HTML, Markdown, or plain text. The model is unloaded from RAM once it's been idle to free resources." />
                        </div>
                    </section>

                    {/* ── Under the hood ── */}
                    <section className="flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading overline="Tech stack" title="Under the hood" />
                        <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                            {[
                                { label: 'Interface', value: 'React + TypeScript', note: 'Type-safe, interactive UI' },
                                { label: 'Framework', value: 'Tauri', note: 'Lightweight native desktop shell with lower overhead than Electron' },
                                { label: 'AI runtime', value: 'llama.cpp server', note: 'Open-source inference engine; not tied to a proprietary API' },
                                { label: 'Vision model', value: 'Qwen3.5-4b (multimodal)', note: 'Reads the document image directly to extract table values' },
                                { label: 'OCR engine', value: 'Tesseract', note: 'Word-level bounding boxes and per-word confidence' },
                                { label: 'Image preprocessing', value: 'image crate (Rust)', note: 'Grayscale + Lanczos upscaling before OCR, with no system OpenCV dependency' },
                                { label: 'PDF rendering', value: 'PDFium', note: '2000px renders from native PDF pages' },
                                { label: 'Storage', value: 'SQLite', note: 'Session and file metadata stored entirely on-device' },
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
                        <SectionHeading overline="Hardware" title="Adapts to your hardware" />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
                                <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">GPU acceleration</p>
                                <h3 className="font-headline-md text-headline-md text-on-surface">Automatic detection</h3>
                                <p className="font-body-md text-body-md text-on-surface-variant">
                                    On first run, Anchor detects your graphics card and downloads the matching
                                    accelerated build: NVIDIA (CUDA) on Windows, or Apple Silicon (Metal) on macOS.
                                </p>
                                <p className="font-body-sm text-body-sm text-on-surface-variant">
                                    Support for other acceleration backends, such as AMD, may be added in a future release.
                                </p>
                            </div>
                            <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
                                <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">CPU fallback</p>
                                <h3 className="font-headline-md text-headline-md text-on-surface">No GPU needed</h3>
                                <p className="font-body-md text-body-md text-on-surface-variant">
                                    Anchor runs the full pipeline on your CPU, and a GPU build automatically
                                    falls back to CPU if acceleration can't initialize.
                                </p>
                            </div>
                        </div>
                        <p className="font-body-md text-body-md text-on-surface-variant max-w-2xl">
                            The installer is small; the AI model and platform binaries are downloaded once on
                            first launch and SHA-256 verified: about 3.5 GB (CPU or Apple Silicon), or ~4 GB
                            on Windows with the NVIDIA CUDA build.
                        </p>
                    </section>

                    {/* ── Download ── */}
                    <section id="download" className="scroll-mt-20 flex flex-col gap-8 pb-16 sm:pb-24">
                        <SectionHeading
                            overline="Get started"
                            title="Download Anchor"
                            body="A small installer pulls the rest on first launch. No account, no sign-in, just install and start extracting."
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <DownloadCard
                                icon="window"
                                platform="Windows"
                                detail="Windows 10 (22H2+) or 11 · 64-bit"
                                href={releaseAssets.windows ?? LINKS.releases}
                                direct={Boolean(releaseAssets.windows)}
                                cta="Download installer"
                                note="Installer via GitHub Releases (Unsigned for now)."
                            />
                            {/* Microsoft Store listing is not live yet (docs/release.md §6).
                                Card is disabled rather than deleted so it's a one-line revert once the
                                listing ships; re-add it to the grid above and switch back to
                                sm:grid-cols-3 when that happens.
                            <DownloadCard
                                icon="storefront"
                                platform="Microsoft Store"
                                detail="One-click install · auto-update"
                                href={LINKS.microsoftStore}
                                cta="Get from Store"
                                note="Coming with the Store listing."
                            /> */}
                            <DownloadCard
                                icon="laptop_mac"
                                platform="macOS"
                                detail="Apple Silicon (M-series) only"
                                href={releaseAssets.mac ?? LINKS.macDownload}
                                direct={Boolean(releaseAssets.mac)}
                                cta="Download DMG"
                                note="Installer via GitHub Releases (Unsigned for now)."
                            />
                        </div>
                        {/* The in-app clickwrap is the actual gate — nothing downloads or
                            runs before it is accepted — but a download here bypasses the
                            Store, so the terms are named at the point of download too
                            rather than only in the footer. */}
                        <p className="font-body-sm text-body-sm text-on-surface-variant">
                            By downloading and installing Anchor you agree to the{' '}
                            <a href="/terms" className="text-primary underline underline-offset-2">
                                Terms of Use &amp; EULA
                            </a>{' '}
                            and the{' '}
                            <a href="/privacy" className="text-primary underline underline-offset-2">
                                Privacy Policy
                            </a>. You will be asked to accept them on first launch, before anything is
                            downloaded. Anchor extracts data using a local AI model, so verify results
                            against your source document before relying on them.
                        </p>

                        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6">
                            <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-4">System requirements</p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-y-3 gap-x-6">
                                {[
                                    { icon: 'devices', label: 'Windows 10 (22H2+)/11, or macOS on Apple Silicon' },
                                    { icon: 'memory', label: '8 GB RAM minimum' },
                                    { icon: 'hard_drive', label: '~3.5 GB free disk for models (~4 GB with CUDA)' },
                                    { icon: 'wifi', label: 'Internet for first-run setup only' },
                                    { icon: 'developer_board', label: 'Optional NVIDIA or Apple Silicon GPU acceleration' },
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
                <footer className="border-t border-outline-variant bg-surface">
                    <div className="max-w-6xl mx-auto px-5 sm:px-8 lg:px-[--spacing-margin-page] py-10 flex flex-col gap-6">
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                            <div className="flex items-center gap-2 text-on-surface-variant">
                                <AnchorMark className="w-6 h-6 rounded-md" />
                                <span className="font-body-md text-body-md">Anchor · Local AI Data Extraction</span>
                            </div>
                            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-label-md text-label-md text-on-surface-variant">
                                <a href={LINKS.github} target="_blank" rel="noreferrer" className="hover:text-on-surface transition-colors no-underline">GitHub</a>
                                <a href={LINKS.releases} target="_blank" rel="noreferrer" className="hover:text-on-surface transition-colors no-underline">Releases</a>
                                <a href="#download" className="hover:text-on-surface transition-colors no-underline">Download</a>
                                <a href="/privacy" className="hover:text-on-surface transition-colors no-underline">Privacy</a>
                                <a href="/terms" className="hover:text-on-surface transition-colors no-underline">Terms</a>
                                <a href="/licenses" className="hover:text-on-surface transition-colors no-underline">Licenses</a>
                            </div>
                        </div>
                        <div className="border-t border-outline-variant pt-6 flex flex-col gap-3 text-center sm:text-left font-body-sm text-body-sm text-on-surface-variant">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                                <span>
                                    © {copyrightYears()} Aiden Paleczny · Licensed under the Elastic License 2.0.
                                </span>
                                <span className="text-on-surface-variant">
                                    Copyright or security concerns:{' '}
                                    <a href="mailto:aiden.paleczny@gmail.com" className="text-primary underline underline-offset-2 wrap-break-word">aiden.paleczny@gmail.com</a>
                                </span>
                            </div>
                            <p className="max-w-2xl mx-auto sm:mx-0">
                                Anchor uses a local generative-AI model; verify AI output before relying on it.
                            </p>
                        </div>
                    </div>
                </footer>
            </div>
        </div>
    );
}
