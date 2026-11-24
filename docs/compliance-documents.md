# Compliance documents

The legal-document inventory: what exists, where each document is the source of truth,
where it is rendered, and what has to move together when one changes.

Cited from `app/vite.config.ts`, `website/vite.config.ts`,
`app/src/features/legal/legalContent.ts`, `website/src/legal/legalContent.ts`, and
`docs/release.md`. §2 is the section those comments point at.

Related: [legal-audit-2026-08-04.md](legal-audit-2026-08-04.md) — the point-in-time audit
these rules were written out of. [release.md](release.md) — Microsoft Store policy status.

---

## 1. The documents

| Document | Path | Governs | Versioned by |
|---|---|---|---|
| EULA / Terms of Use | `docs/legal/EULA.md` | Use of the installed app, and (§15) the website | `Effective date` line + `EULA_VERSION` |
| Privacy Policy | `docs/legal/PRIVACY.md` | App, website, and download service | `Effective date` line |
| Third-Party Notices | `NOTICES.md` | Attribution for every redistributed component | `Last regenerated` line |
| Source licence | `LICENSE` (Elastic 2.0) | The source code, not the installed app | — |
| Security policy | `SECURITY.md` | Vulnerability, AI-output, and takedown reporting | — |

`LICENSE` and the EULA cover different things and both are needed: the Elastic License
governs the source in the repo, the EULA governs the binary a user installs. The EULA says
so in its preamble, and `LICENSE` carries a closing note that third-party components are
not licensed under it.

## 2. Single source of truth

**`docs/legal/` and `NOTICES.md` are the only copies of this text in the repo.** The app,
the website, and the GitHub view all render those same files. Nothing paraphrases them.

```
docs/legal/EULA.md ──┬─→ app/src/features/legal/legalContent.ts     (?raw)  → /legal/terms
                     │                                                      → setup wizard tab
                     └─→ website/src/legal/legalContent.ts          (?raw)  → /terms
docs/legal/PRIVACY.md ─ (same two importers)                                → /legal/privacy, /privacy
NOTICES.md ──────────── (same two importers)                                → /legal/notices, /licenses
```

Both importers use Vite's `?raw` suffix and reach outside their own package root, which is
why each `vite.config.ts` sets `server.fs.allow: ['..']` — dev-server only; the production
build inlines the strings at build time, so the app works fully offline and the website
needs no runtime fetch.

Consequences worth stating plainly:

- **A Store-linked URL can never contradict what the app shows.** They are the same bytes.
- **Editing a document in one place updates every surface.** There is no second copy to
  forget.
- **Adding a legal document means adding an importer in both packages**, not copying text.

### Rendering

Privacy and the EULA go through a deliberately minimal Markdown renderer
(`app/src/features/legal/Markdown.tsx`, `website/src/legal/Markdown.tsx`) that supports
only the constructs those two documents use — no third-party Markdown dependency, which
would itself need a `NOTICES.md` entry. `NOTICES.md` contains large tables the minimal
renderer does not handle, so it renders as preformatted text: verbatim and complete, which
is what an attribution file needs anyway.

Relative cross-references between the documents (`[Privacy Policy](PRIVACY.md)`) are
rewritten per-surface by each renderer's `RELATIVE_DOC_ROUTES` map — to `#/legal/privacy`
in the app, `/privacy` on the site. A new cross-reference target needs an entry in both
maps, or the link renders as inert text.

## 3. Consent

The clickwrap lives in `app/src/features/setup/steps/TermsStep.tsx`, as a step of the setup
wizard, and is recorded by `app/src/features/legal/eulaAcceptance.ts`.

Invariants, each enforced by code or a test rather than by convention:

1. **Consent precedes any download or execution.** `SetupWizard.stepsFor` places `terms`
   ahead of `install` on every path, including the one-click automatic path, and `App.tsx`
   renders the wizard *instead of* the router until acceptance is recorded. Nothing of the
   ~3.5 GB of third-party binaries is fetched or run before the user agrees. Covered by
   `SetupWizard.dom.test.tsx` and `e2e/specs/setup.e2e.ts`.
2. **Acceptance is affirmative.** A checkbox plus a Continue click; the checkbox label
   independently restates the AI-inaccuracy disclaimer rather than relying only on
   incorporation by reference.
3. **`EULA_VERSION` equals the EULA's effective date.** The consent record has to name the
   document the user was shown. Enforced by `legalContent.test.ts`, which parses the date
   out of the bundled markdown. This drifted once (see §5).
4. **Storage failure fails closed.** If `localStorage` throws, the gate shows.
5. **The record is durable.** Acceptance is mirrored to `consent.json` in the app-data
   directory, so it survives webview storage being cleared; `localStorage` stays the fast
   path. "Remove all app data" clears both, deliberately — the wipe promises everything.

### Changing the terms

1. Edit `docs/legal/EULA.md`, including the **Effective date** line.
2. Set `EULA_VERSION` in `app/src/features/legal/legalContent.ts` to the same date.
3. Run the app tests. `legalContent.test.ts` fails if the two disagree, or if a `Section N`
   cross-reference no longer resolves after renumbering.

On the next launch every user is re-prompted, because their stored version no longer
matches. The wizard runs as a consent-only step and says the terms have changed
(`ConsentContext = 'terms-updated'`), without repeating the first-install copy that
promises nothing has been downloaded yet — which would be false on a machine that already
has the assets.

Keep the Privacy Policy's effective date equal to the EULA's when either changes: the
consent step presents both documents and records one version for the pair, and
`legalContent.test.ts` asserts the two dates match.

## 4. Attribution (`NOTICES.md`)

Regenerate whenever a dependency, a font, or a downloaded runtime component changes:

```bash
npm ls --omit=dev --all --json        # in app/    → §2
cargo metadata --format-version 1     # in app/src-tauri/ → §3
```

§3 is reconciled by **name and version** against `cargo metadata` — as of 2026-08-04, 718
rows for 718 packages, with nothing missing, nothing extra, and no licence string that
disagrees with the crate's own manifest. Reconcile that way rather than eyeballing the
table; the drift that hid there was an entire plugin's subtree.

Three traps:

- **Native DLLs that ship in the Windows installer.** Neither `npm ls` nor
  `cargo metadata` sees them, because they aren't packages: `DirectML.dll` (MIT, noted under
  §1.6) and the Microsoft Visual C++ runtime (§1.8) come from `ort-sys`'s prebuilt ONNX
  Runtime and from Visual Studio's redist folder, staged by
  `app/scripts/stage-windows-runtime.mjs`. That script prints every DLL it staged on each
  `tauri build`. **If that list changes, NOTICES §1.6/§1.8 and EULA §7 change with it.**
  The Visual C++ runtime is proprietary Microsoft "Distributable Code", and its terms require
  end users to be bound by terms at least as protective as Microsoft's. EULA §7's
  *Proprietary runtime components* paragraph is that flow-down, and it covers the NVIDIA
  CUDA runtime on the same basis. Don't drop it from the EULA while either component ships.
  Checked 2026-11-24 against:
  - the Visual Studio 2026 distributable list
    (<https://learn.microsoft.com/visualstudio/releases/2026/redistribution>: `VC\redist`
    and its subfolders may be distributed unmodified, excluding `debug_nonredist` and
    anything marked pre-release or preview, so build only from a `VisualStudio.*.Release`
    channel install);
  - Microsoft's end-user license for the runtime itself (`Cpp_2015-2022_ENU.1033`, extracted
    from `vc_redist.x64.exe`), whose restrictions §7 mirrors;
  - the NVIDIA CUDA EULA v13.5 (last updated 2026-01-26). Its §1.1.2(5) requires consistent
    downstream terms; §1.2(2) bars modification and derivative works; Attachment A lists
    `cudart`/`cublas`/`cublasLt` as redistributable.

  Two obligations of yours that are not EULA text:
  - **NVIDIA §1.1.2(6):** notify NVIDIA in writing of any known or suspected non-compliant
    distribution or use, and enforce the EULA with respect to the CUDA runtime.
  - **NVIDIA §1.2(3):** never present Anchor as sponsored or endorsed by NVIDIA. The same
    applies to Microsoft.

  **Build Tools 2026 license (last updated 2025-10-01), read 2026-11-24.** It has **no
  Distributable Code section**:
  - §4(e) forbids distributing "the software or any of its code" under it.
  - §1(a) licenses it only as a supplement to Visual Studio Community, Professional or
    Enterprise, and requires a valid license to one of those.

  So the right to ship the runtime DLLs comes from the **Visual Studio Community** license's
  Distributable Code section (Anchor's author qualifies for Community as an individual
  developer), via the distributable list. Two consequences:
  - **Build devices (§2(b)).** Build Tools may run only on machines you own, machines
    "hosted on Microsoft Azure for you", or machines an Authorized Outsourcer manages solely
    for you. A GitHub-hosted runner is Microsoft-owned and runs on Azure, but it is neither
    dedicated to you nor running a Visual Studio you installed. `release.yml` stages the CRT
    from that runner, so this is the least clear-cut link. Building releases on your own
    machine removes the question.

  **Visual Studio Community 2026 license (last updated 2025-10-01), read 2026-11-24.**
  §2(b) covers an individual working on their own applications, including to sell them. §8
  (Distributable Code) grants the Distributable List. §8(b) imposes three requirements:
  1. **Add significant primary functionality.** Met.
  2. **"Require distributors and external end users to agree to terms that protect the
     Distributable Code at least as much as these license terms."** The content is met: EULA
     §7's (a)–(f) mirror Community §11 item for item, unlawful use is covered by EULA §6(a),
     and export by EULA §14. The *timing* is met because the installer's license page shows
     the EULA (`bundle.licenseFile` in `tauri.conf.json`). The DLLs land on disk at install,
     before the in-app clickwrap runs, so the installer page is where users first agree. Until
     2026-11-24 that page showed `LICENSE` (Elastic-2.0, the *source* license, which grants
     copy/distribute/modify rights), so it must stay the EULA. A third-party distributor
     (Microsoft Store, winget) must also present the EULA.
  3. **"Indemnify, defend, and hold harmless Microsoft from any claims, including attorneys'
     fees, related to the distribution or use of your applications, except to the extent
     that any claim is based solely on the Distributable Code."** This obligation falls on
     the author personally and cannot be passed to users. With no corporate entity, it is
     unlimited personal exposure, which is one more reason for the "incorporate before
     charging" item in `release.md`.

  §8(c) is met: release-channel components only, no Microsoft trademarks in the app's name
  or presented as an endorsement, and no Microsoft source code shipped. §7(c) repeats the
  Build Devices definition above, so the GitHub-runner question applies under this license
  too.

- **Fonts.** `§2.1` covers Inter, Source Serif 4 (both SIL OFL 1.1) and Material Symbols
  (Apache-2.0). These are font *binaries* shipped in the installer and in the website
  build, and OFL clause 1 requires the notice and licence text to travel with them — an
  obligation the package table's format does not express, which is exactly why they went
  unlisted. Full OFL text is Appendix E.
- **Build-only tooling does not ship.** `tailwindcss` and `@tailwindcss/vite` sit in
  `dependencies`, so a production `npm ls` drags in Vite, Rollup, esbuild, LightningCSS and
  the platform-native binaries. The paragraph after the §2 table says so explicitly; don't
  list them as redistributed.

## 5. Known history

Recorded so the same drift is recognisable if it recurs.

- **`EULA_VERSION` vs effective date (fixed 2026-08-04).** Commit `0366c8d` moved the
  effective date 2026-07-20 → 2026-07-23 and introduced `EULA_VERSION` hard-coded to the
  pre-bump date in the same commit. That revision shipped without re-prompting anyone, and
  every consent record written in between cited a document that no longer existed. Now
  guarded by a test.
- **Google Fonts (fixed in the app, then on the website 2026-08-04).** Both surfaces
  `<link>`ed Inter, Source Serif 4 and Material Symbols from `fonts.googleapis.com` /
  `fonts.gstatic.com`. The app's copy was removed because it contradicted the on-device
  claim and broke offline rendering; the website's survived, sending every visitor's IP
  address and user-agent to Google while Privacy Policy §4 told them the site had no
  third-party tracking. Both are self-hosted now. **Do not reintroduce a remote font
  origin on either surface.**
- **`NOTICES.md` staleness (fixed 2026-08-04).** Adding `tauri-plugin-clipboard-manager`
  pulled in 18 crates that were never added to §3, and the three bundled fonts had never
  been listed at all — while EULA §7 and `release.md`'s Store-policy 11.2 row both asserted
  the file was complete.
- **Load-time DLLs missing from the Windows installer (fixed 2026-11-24).** The oar-ocr
  integration made `Anchor.exe` import `DirectML.dll` and the MSVC C++ runtime at load time.
  Every dev build and the `target\release` smoke test found them anyway: `ort-sys` symlinks
  DirectML beside the exe, and a dev machine has the redistributable installed. The installer
  shipped neither, so a clean Windows machine would have failed before the clickwrap could
  even be shown. NOTICES §1.6 also claimed DirectML was "copied next to the executable", and
  EULA §7 named neither component. Fixed by bundling both (`stage-windows-runtime.mjs`), adding
  NOTICES §1.8 and the EULA §7 flow-down, and bumping the terms to 2026-11-24 so every user is
  asked to accept again.
