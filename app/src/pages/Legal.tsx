import React from 'react';
import { useParams, Link } from 'react-router';
import Icon from '../components/Icon';
import Markdown from '../features/legal/Markdown';
import { LEGAL_DOCS, type LegalDocId } from '../features/legal/legalContent';

const VALID: LegalDocId[] = ['privacy', 'terms', 'notices'];

function isLegalDocId(v: string | undefined): v is LegalDocId {
    return v !== undefined && (VALID as string[]).includes(v);
}

/**
 * In-app viewer for the legal documents, reachable at /legal/:doc. Privacy and
 * Terms render through the lightweight Markdown component; Notices (which contains
 * large dependency tables the minimal renderer doesn't handle) renders as
 * preformatted text so the full attribution text is shown verbatim and complete.
 */
export default function Legal(): React.ReactElement {
    const { doc } = useParams();
    const id: LegalDocId = isLegalDocId(doc) ? doc : 'privacy';
    const { title, markdown } = LEGAL_DOCS[id];

    return (
        <main className="absolute inset-0 overflow-y-auto bg-surface">
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-primary via-transparent to-transparent" />

            <div className="relative z-10 max-w-5xl mx-auto px-[--spacing-margin-page] py-12 flex flex-col gap-6">
                <div className="flex items-center gap-2 font-label-md text-label-md">
                    {VALID.map((d) => (
                        <Link
                            key={d}
                            to={`/legal/${d}`}
                            className={`px-3 py-1.5 rounded-lg transition-colors ${
                                d === id ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'
                            }`}
                        >
                            {LEGAL_DOCS[d].title}
                        </Link>
                    ))}
                    <Link
                        to="/about"
                        className="ml-auto flex items-center gap-1 text-on-surface-variant hover:text-on-surface transition-colors"
                    >
                        <Icon name="arrow_back" size={16} />
                        Back
                    </Link>
                </div>

                <article className="rounded-2xl border border-outline-variant bg-surface-container-low px-6 sm:px-8 py-6">
                    {id === 'notices' ? (
                        <div className="flex flex-col gap-3">
                            <h1 className="font-display-sm text-display-sm text-primary tracking-tight">{title}</h1>
                            <p className="font-body-md text-body-md text-on-surface-variant">
                                Anchor is built with, and redistributes, the third-party components and AI models
                                listed below, each under its own license. Full text follows.
                            </p>
                            <pre className="mt-2 max-h-none overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-container p-4 font-mono text-xs leading-relaxed text-on-surface-variant">
                                {markdown}
                            </pre>
                        </div>
                    ) : (
                        <Markdown source={markdown} />
                    )}
                </article>
            </div>
        </main>
    );
}
