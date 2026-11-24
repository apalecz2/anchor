// Canonical legal text, imported straight from the repo's single source of truth
// in docs/legal/ and NOTICES.md (see docs/compliance-documents.md §2). The app,
// the website, and the GitHub repo therefore all render byte-identical text — the
// Store-linked URL can never contradict what the app shows. Bundled at build time
// as strings so they are available fully offline.
import privacyMarkdown from '../../../../docs/legal/PRIVACY.md?raw';
import eulaMarkdown from '../../../../docs/legal/EULA.md?raw';
import noticesMarkdown from '../../../../NOTICES.md?raw';

export { privacyMarkdown, eulaMarkdown, noticesMarkdown };

/**
 * The version string recorded when a user accepts the terms. It must equal the
 * "Effective date" line in EULA.md, so the consent record names the document the
 * user was actually shown — that record is the evidence the clickwrap exists for,
 * and it is worthless if it cites a version that was never displayed. A bump also
 * invalidates older acceptances, which is what re-prompts users after a revision
 * (see eulaAcceptance.ts).
 *
 * This drifted once: the effective date moved 2026-07-20 -> 2026-07-23 while this
 * constant stayed behind, so that revision shipped without re-prompting anyone and
 * every record written pointed at a superseded document. `legalContent.test.ts`
 * now parses the date out of the bundled markdown and fails if the two disagree —
 * edit the date in EULA.md and this constant together, or the test will say so.
 */
export const EULA_VERSION = '2026-11-24';

export type LegalDocId = 'privacy' | 'terms' | 'notices';

export const LEGAL_DOCS: Record<LegalDocId, { title: string; markdown: string }> = {
    privacy: { title: 'Privacy Policy', markdown: privacyMarkdown },
    terms: { title: 'Terms of Use & EULA', markdown: eulaMarkdown },
    notices: { title: 'Licenses & Notices', markdown: noticesMarkdown },
};
