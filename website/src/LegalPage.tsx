import React from 'react';
import Icon from './components/Icon';
import AnchorMark from './components/AnchorMark';
import Markdown from './legal/Markdown';
import { LEGAL_DOCS, type LegalDocId } from './legal/legalContent';
import { syncFaviconToSystemTheme } from './favicon';
import { copyrightYears } from './copyright';

/**
 * Standalone legal page rendered at /privacy, /terms, and /licenses — the stable,
 * permanent URLs the Microsoft Store listing and the app link to. Privacy and Terms
 * render through the minimal Markdown component; Licenses (NOTICES, which contains
 * large dependency tables) renders as verbatim preformatted text.
 */
export default function LegalPage({ doc }: { doc: LegalDocId }): React.ReactElement {
    React.useEffect(() => syncFaviconToSystemTheme(), []);
    const { title, markdown } = LEGAL_DOCS[doc];

    return (
        <div className="relative bg-surface min-h-screen">
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-primary via-transparent to-transparent" />

            <div className="relative z-10">
                <header className="sticky top-0 z-50 border-b border-outline-variant bg-surface/80 backdrop-blur-md">
                    <div className="max-w-5xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between gap-4">
                        <a href="/" className="flex items-center gap-2 text-on-surface no-underline">
                            <AnchorMark className="w-9 h-9 rounded-lg" />
                            <span className="font-headline-md text-headline-md leading-none">Anchor</span>
                        </a>
                        <a
                            href="/"
                            className="flex items-center gap-1.5 font-label-md text-label-md text-on-surface-variant hover:text-on-surface transition-colors no-underline"
                        >
                            <Icon name="arrow_back" size={16} />
                            Back to site
                        </a>
                    </div>
                </header>

                <main className="max-w-5xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
                    <nav className="flex flex-wrap items-center gap-2 mb-8 font-label-md text-label-md">
                        {(Object.keys(LEGAL_DOCS) as LegalDocId[]).map((d) => (
                            <a
                                key={d}
                                href={LEGAL_DOCS[d].path}
                                className={`px-3 py-1.5 rounded-lg transition-colors no-underline ${
                                    d === doc ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'
                                }`}
                            >
                                {LEGAL_DOCS[d].title}
                            </a>
                        ))}
                    </nav>

                    <article className="rounded-2xl border border-outline-variant bg-surface-container-low px-5 sm:px-8 py-6">
                        {doc === 'licenses' ? (
                            <div className="flex flex-col gap-3">
                                <h1 className="font-display-sm text-headline-lg sm:text-display-sm text-primary tracking-tight">{title}</h1>
                                <p className="font-body-md text-body-md text-on-surface-variant">
                                    Anchor is built with, and redistributes, the third-party components and AI models
                                    listed below, each under its own license. Full text follows.
                                </p>
                                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-container p-4 font-mono text-xs leading-relaxed text-on-surface-variant">
                                    {markdown}
                                </pre>
                            </div>
                        ) : (
                            <Markdown source={markdown} />
                        )}
                    </article>
                </main>

                <footer className="border-t border-outline-variant bg-surface">
                    <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 flex flex-col sm:flex-row items-center justify-between gap-3 font-body-sm text-body-sm text-on-surface-variant">
                        <span>
                            Anchor · © {copyrightYears()} Aiden Paleczny · Licensed under the Elastic License 2.0.
                        </span>
                        <div className="flex items-center gap-5">
                            <a href="/privacy" className="hover:text-on-surface transition-colors no-underline">Privacy</a>
                            <a href="/terms" className="hover:text-on-surface transition-colors no-underline">Terms</a>
                            <a href="/licenses" className="hover:text-on-surface transition-colors no-underline">Licenses</a>
                        </div>
                    </div>
                </footer>
            </div>
        </div>
    );
}
