# Release & distribution — Anchor

**Single source of truth** for how Anchor is built, versioned, signed, published, and
(eventually) listed on the Microsoft Store. Consolidated 2026-07-27 from the four earlier
docs — `release-strategy.md`, `store-release-plan.md`, `app-distribution.md`,
`microsoft-store.md` — which are now deleted; everything still true from them is here.

Related docs that are **not** duplicated here:
- [compliance-documents.md](compliance-documents.md) — the legal-document inventory (what
  exists, where it lives). This doc covers only the release-gating slice.
- [cloudflare-r2-setup.md](cloudflare-r2-setup.md) — the R2 asset bucket the first-run
  wizard downloads from.
- [TEST_PLAN.md](TEST_PLAN.md) / [TESTING.md](TESTING.md) — test spec and status.
- [issues.md](issues.md) / [todo.md](todo.md) — open product work.

---

## 1. Where things actually stand

Verified 2026-07-27 (GitHub API + HTTP checks against the live site).

| Area | State |
|---|---|
| **Repo** | `github.com/apalecz2/anchor`, public, Elastic License 2.0. **Renamed** from `DataExtractionAI` — the local `origin` remote still points at the old URL and works only via GitHub's redirect (§8). |
| **Website** | Live at **https://anchor.aidenpaleczny.com** (set as the repo homepage). `/privacy`, `/terms`, `/licenses` all return 200 as pre-rendered static routes. |
| **Releases** | **Public on GitHub Releases**: `v0.1.0` and `v0.1.1` (2026-06-23), `v0.2.0` (2026-07-24). All three are flagged **pre-release**. |
| **Release automation** | [`.github/workflows/release.yml`](../.github/workflows/release.yml) — tag-triggered (`v*`) or manual; builds **Windows** + **macOS universal** via `tauri-action` and publishes a **draft** release. |
| **v0.2.0 artifacts** | `Anchor_0.2.0_x64-setup.exe` (6.8 MB, NSIS), `Anchor_0.2.0_x64_en-US.msi` (9.9 MB), `Anchor_0.2.0_universal.dmg` (20.1 MB), `Anchor_universal.app.tar.gz` (20 MB). |
| **Versioning** | `productName: "Anchor"`, `version: 0.3.0` in [tauri.conf.json](../app/src-tauri/tauri.conf.json); `app/package.json` and `app/src-tauri/Cargo.toml` match and carry `author`/`description`/`license: Elastic-2.0`. Five files hold the version — §4.1. |
| **Executable name** | `Anchor.exe`, from the `[[bin]] name` in [Cargo.toml](../app/src-tauri/Cargo.toml) — **not** from `productName`. Renamed for 0.3.0: the package was called `app`, so v0.1.x–v0.2.0 installed as `app.exe` (`%LOCALAPPDATA%\Anchor\app.exe`). Existing installs get the new name via the NSIS uninstall-then-install upgrade; pinned shortcuts to the old path break and need re-pinning. |
| **Code signing** | ❌ **None on either platform.** No Authenticode/Azure Trusted Signing, no Apple Developer ID, no notarization, no `entitlements.plist`. The site says "Unsigned for now" on both download cards. |
| **Microsoft Store** | ❌ Not started — no Partner Center account, no reserved name, no MSIX packaging. Website leaves the Store link empty by design. |
| **Legal/compliance** | ✅ Audited and remediated 2026-08-04 ([legal-audit-2026-08-04.md](legal-audit-2026-08-04.md), inventory in [compliance-documents.md](compliance-documents.md)): `LICENSE` (Elastic-2.0), `NOTICES.md` (CUDA runtime, bundled fonts under OFL-1.1/Apache-2.0, §3 reconciled name+version against `cargo metadata`), `SECURITY.md`, `PRIVACY.md` + `EULA.md` published on the site, first-run clickwrap gate with a durable AppData consent record, in-app legal viewer, Qwen verified Apache-2.0 for R2 redistribution. EULA now carries indemnity, pre-release, capacity, and limitation-of-actions clauses. **Remaining exposure is structural, not textual: Anchor is published by an individual, so there is no corporate veil** — incorporate before charging for Paid Features. |
| **Packaged-build gate** | ✅ **Passed.** The old "does llama-server start in a built release" blocker is resolved — v0.2.0 was built, released, and the CSP fix from [issues.md](issues.md) (Build/Packaging #1) came out of running the packaged app end-to-end. |
| **Data removal** | ✅ Settings ▸ Data has *Reset Anchor* (wipe → first-run setup) and *Remove all data and quit* (wipe → exit, for uninstalling), alongside *Delete all sessions*. Both clear AppData, the database, and the OCR scratch cache ([reset.rs](../app/src-tauri/src/reset.rs)); §6.4 still needs the MSIX-uninstall half verified on a VM. |
| **In-app updater** | ❌ None. Tauri's updater is not configured (the `.app.tar.gz` asset is its artifact, currently unused). Users re-download to update. |

**What this means:** the old docs' central premise — "the packaged build is unverified and
gates everything" — is obsolete. Three tagged releases exist for both platforms. The
binding constraint now is **trust**: unsigned installers, on a product whose entire pitch
is handling sensitive documents.

---

## 2. Channels

| Channel | Status | Notes |
|---|---|---|
| **GitHub Releases** (Windows NSIS/MSI, macOS DMG) | ✅ Live, CI-driven | Primary channel. Linked from the website download cards. |
| **Website** (`anchor.aidenpaleczny.com`) | ✅ Live | Marketing + legal pages; download buttons deep-link to GitHub Releases. |
| **Microsoft Store (MSIX)** | 🔜 Planned (§6) | Windows only. Free Microsoft signing, one-click install, auto-update. |
| **Mac App Store** | ➖ Not planned | Sandboxing is incompatible with downloading and spawning `llama-server`/`tesseract`. Direct notarized DMG is the macOS path. |
| **winget / Homebrew Cask** | ➖ Deferred | Cheap to add *after* signing; both effectively require signed artifacts to be worth doing. |
| **Enterprise (Intune, offline provisioning)** | ➖ Deferred (§9) | Only if a managed-fleet customer appears. |

---

## 3. Next steps, in order

Ranked by what unblocks what. Each item states its exit criterion.

### N1 — Fix the "latest release" links · ~15 min · do first
Every release is flagged **pre-release**, so `https://github.com/apalecz2/anchor/releases/latest`
**404s at the API level** and the web URL just redirects to the releases *list* — the
website's download buttons drop visitors on a list page instead of a download, and any
tooling that queries `/releases/latest` gets a 404.

Pick one:
- **Promote** the current release (uncheck "pre-release" on `v0.2.0`) — the site already
  frames the app as beta in the hero, so the GitHub flag is redundant; or
- keep pre-release framing and **link the tag directly** (`/releases/tag/v0.2.0`) in
  [website/src/App.tsx](../website/src/App.tsx).

Also reconcile the workflow with reality: `release.yml` sets `prerelease: false` but every
published release is a pre-release, so the flag is being flipped by hand each time. Set
`prerelease: true` there if that's the intent.

**Exit:** the website's Windows and macOS buttons land a user on an actual installer file.

### N2 — macOS signing + notarization · ~½ day + Apple Developer enrollment ($99/yr)
The unsigned universal DMG is the worst install experience of the two: Gatekeeper reports
`"Anchor" is damaged and can't be opened` (quarantine + no valid signature), which reads as
malware, not as an unsigned app. There is no "More info → Run anyway" escape hatch like
Windows has.

- [ ] Enroll in the Apple Developer Program; create a **Developer ID Application** cert.
- [ ] Add the signing block + `entitlements.plist` (§5.2) — **`com.apple.security.cs.disable-library-validation`
      is mandatory**, or a correctly notarized build still fails to load the
      wizard-downloaded `libpdfium.dylib` (signed by Google, not your Team ID) and PDF
      rendering breaks.
- [ ] Wire the Apple env vars into `release.yml` as repo secrets.
- [ ] Re-cut a release; verify on a clean Mac that downloading and opening produces **no
      warning**, and that a real PDF extraction works.

**Exit:** notarized, stapled DMG that opens with no Gatekeeper dialog.

### N3 — Windows code signing (Azure Trusted Signing) · ~½ day + provider onboarding
Removes the SmartScreen "Windows protected your PC" wall. Azure Trusted Signing is ~$10/mo,
chains to a Microsoft-trusted root, needs no hardware token, and runs in CI — far cheaper
than a traditional OV/EV cert ($200–500/yr). Verify individual-developer eligibility when
signing up (it has changed more than once; if individual enrollment is unavailable, the
fallback is an OV cert or leaning on Store signing per §6).

- [ ] Set up Azure Trusted Signing; add the signing step/env to `release.yml` (§5.1).
- [ ] Re-cut a release; confirm a fresh download of the `.exe` installs with no SmartScreen
      prompt on a clean VM.

**Exit:** signed installer, signing automated in CI, no SmartScreen warning.

### N4 — Interim install guidance (only while N2/N3 are outstanding)
Cheap mitigation, and the fix [website-copy-review.md](website-copy-review.md) §1 asks for:
add a short "Why does my computer warn about this?" link beside each download card
covering SmartScreen (**More info → Run anyway**) and macOS
(right-click → **Open**, or `xattr -d com.apple.quarantine /Applications/Anchor.app`).
Delete it once both platforms are signed.

### N5 — "Remove all downloaded data" · ✅ done (in-app half)
Uninstalling left ~3.5 GB of models/binaries plus the SQLite DB and page-image cache in
AppData — a trust issue, and a **hard Store requirement** (Policy 10.2.7, §6.4).

Shipped: two sibling actions beside *Delete all sessions* in Settings ▸ Data, both backed by
[reset.rs](../app/src-tauri/src/reset.rs) — *Reset Anchor* (wipe, then return to first-run
setup) and *Remove all data and quit* (wipe, then exit, so an uninstall leaves nothing).
The wipe stops llama-server and cancels OCR/downloads first (the GGUF is memory-mapped, and
Windows will not delete an open file), clears the AppData **and** config directories plus the
`ocr` cache subtree, and the frontend closes the SQLite pool before it and clears webview
storage after. Partial failures are reported per path rather than swallowed.

Deliberately **not** wiped: the WebView2 profile under `%LOCALAPPDATA%\<identifier>`, which is
live while the app runs — it holds settings only, and those are cleared from JS.

Still open: (a) confirm on a VM what MSIX/NSIS uninstall clears on its own, and (b) decide
whether to add an NSIS uninstall hook now that the in-app path exists.

### N6 — Microsoft Store (MSIX) · ~1–2 weeks including review
The remaining distribution milestone: free signing, one-click install, auto-update, reach,
and a "published on the Microsoft Store" line for the portfolio. Full plan in §6. Note the
sequencing: if N3 lands first, the Store's *free signing* stops being the main draw and the
Store becomes about reach and install UX — that's fine, but it means the Store is genuinely
optional rather than the only affordable path.

### N7 — Housekeeping
- [x] Point the local `origin` remote at the renamed repo (§8). *(done)*
- [ ] Decide whether to keep publishing the `.app.tar.gz` updater artifact (unused without a
      configured updater) or drop it from the release.
- [ ] Consider an in-app update check (Tauri updater, or a version ping against the GitHub
      releases API) — worth it once installers are signed.

---

## 4. Cutting a release (current process)

1. **Bump the version in all five places** — they must match, and the tag must match them:

   | File | How |
   |---|---|
   | [`app/src-tauri/tauri.conf.json`](../app/src-tauri/tauri.conf.json) → `version` | by hand — **authoritative** |
   | [`app/package.json`](../app/package.json) → `version` | by hand |
   | [`app/src-tauri/Cargo.toml`](../app/src-tauri/Cargo.toml) → `[package] version` | by hand |
   | `app/src-tauri/Cargo.lock` (the `anchor` entry) | `cargo check` regenerates it |
   | `app/package-lock.json` (both `version` keys) | `npm install --package-lock-only` regenerates it |

   The installer filenames and the version the About screen shows (`getVersion()`) both come
   from the **Tauri config** version, so a mismatch produces artifacts that disagree with the
   tag. The two lockfiles don't affect the build, but leaving them stale makes the release
   commit lie about what was built — and a later `cargo`/`npm` run will dirty the tree.

2. **Sanity-check locally** (CI covers this on PRs, but before a tag):
   ```bash
   cd app && npm run build && npm test          # tsc --noEmit + vite build + vitest
   cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --lib
   ```

3. **Tag and push:**
   ```bash
   git tag v0.3.0 && git push origin v0.3.0
   ```
   `release.yml` builds Windows and macOS-universal in parallel and creates a **draft**
   GitHub Release named `Anchor v0.3.0`, with the first-run-download disclosure already in
   the release body.

4. **Verify the draft's artifacts** on a clean machine/VM (§7) before publishing.

5. **Publish** the release; set (or clear) the pre-release flag deliberately — see N1.

6. **Website:** no rebuild needed while the download cards point at `/releases/latest`
   (once N1 makes that resolve). If you switch to tag-pinned URLs, update
   [website/src/App.tsx](../website/src/App.tsx) and redeploy.

**Manual builds** (no tag): `cd app && npm run tauri build` — must run on the target OS.
Outputs land in `app/src-tauri/target/release/bundle/{nsis,msi,dmg,macos}/`.

---

## 5. Code signing

### 5.1 Windows — Azure Trusted Signing

The recommendation stands from the earlier docs and hasn't been executed yet. Once the
account exists, sign in CI: `tauri-action` produces the installers, and the signing step
runs against the built `.exe`/`.msi` (Tauri also supports `signCommand` in
`bundle.windows` so every bundled PE is signed as part of the build — preferable, since the
Store fallback path in §6 requires *all* PE files to be signed, not just the installer).

Cost/benefit vs. alternatives:

| Option | Cost | Verdict |
|---|---|---|
| **Azure Trusted Signing** | ~$10/mo | ✅ Chosen — CI-native, no token, Microsoft-trusted root. |
| OV/EV Authenticode cert | $200–500/yr (+ token for EV) | Skip unless Trusted Signing eligibility fails. |
| Store-only signing (MSIX) | Free | Covers *only* Store-installed users; direct downloads stay unsigned. |
| Stay unsigned | $0 | Current state — costs conversions on the exact audience the product targets. |

### 5.2 macOS — Developer ID + notarization

Add to [`tauri.conf.json`](../app/src-tauri/tauri.conf.json) under `bundle`:

```json
"macOS": {
  "signingIdentity": "Developer ID Application: Aiden Paleczny (TEAMID)",
  "entitlements": "entitlements.plist"
}
```

`app/src-tauri/entitlements.plist` — **the library-validation entitlement is the
non-obvious, load-bearing one:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
```

Without `disable-library-validation`, the hardened runtime refuses to load the downloaded
`libpdfium.dylib` (it's signed by Google, not your Team ID) and PDF rendering fails in an
otherwise perfectly notarized build.

Build/sign/notarize/staple happens inside `npm run tauri build` when these are set:

```bash
export APPLE_ID="aiden.paleczny@gmail.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="XXXXXXXXXX"
export APPLE_SIGNING_IDENTITY="Developer ID Application: Aiden Paleczny (XXXXXXXXXX)"
cd app && npm run tauri build --target universal-apple-darwin
```

Verify:

```bash
codesign -dvvv "…/bundle/macos/Anchor.app" 2>&1 | grep -i runtime
codesign -d --entitlements - "…/Anchor.app" 2>&1 | grep library-validation
xcrun stapler validate "…/bundle/dmg/Anchor_0.3.0_universal.dmg"
```

The wizard-downloaded child binaries (`llama-server`, `tesseract`) need no separate
signing — they're spawned as child processes, not loaded into Anchor's address space, and
the upstream arm64 builds are already ad-hoc signed. (Re-sign with
`codesign -s - --force <binary>` only if you ever repackage them.)

> **Universal build, arm64-only runtime.** The DMG is a universal binary, but the assets
> the wizard downloads (`llama-server`, PDFium) are **arm64-only**, so setup cannot complete
> on Intel Macs. Keep "Apple Silicon only" stated on the website and in the release notes.

---

## 6. Microsoft Store (MSIX) — the plan when you get to it

Mapped to Microsoft Store Policies v7.19 (effective 2025-10-14). Anchor's traits that drive
every decision: <20 MB installer, ~3.5 GB first-run download into AppData, local-first (no
telemetry/accounts/payments), local generative-AI output, English-only, Windows + macOS.

### 6.1 Submission shape

| Item | Decision |
|---|---|
| Package type | **MSIX, full-trust** (`runFullTrust`), submitted unsigned — Microsoft signs it on ingestion. |
| Fallback | Policy **10.2.9** "EXE/MSI via URL": the existing NSIS installer + your own Authenticode cert. Cheaper to reach *if* N3 is already done; use it if MSIX testing fails. |
| Account | **Individual** (~$19 one-time) — no payments or financial data involved. |
| Devices | PC only. |
| Updates | Store auto-updates installed users on each new package version. |
| Category / rating / locale | Productivity · IARC **Everyone / PEGI 3** · English only. |

Two facts shape the whole effort:
1. **Tauri has no MSIX bundler** — you wrap `target/release/` with `makeappx` yourself.
2. **MSIX moves the AppData path** from `%APPDATA%\com.aidenpaleczny.anchor\` to the
   package's virtualized location (`%LOCALAPPDATA%\Packages\<PackageFamilyName>\…`). The
   3.5 GB download, SQLite DB, page-image cache, llama PID file, and `.part` sweep all live
   there. **Verifying that under package identity is the single highest-risk item.**

### 6.2 Packaging steps

1. **Partner Center:** register, **reserve the name early** ("Anchor" is a common word;
   fallback title "Anchor — Local Data Extraction"), then capture Product identity →
   **Package/Identity Name**, **Publisher** (`CN=…`), **Publisher display name**. The
   manifest must match these exactly or the upload is rejected.
2. **Tooling:** Windows 10/11 SDK (`makeappx`, `makepri`, `signtool`).
3. **Build unpackaged:** `cd app && npm run tauri build`, then stage
   `app/src-tauri/target/release/` (the `Anchor.exe` + DLLs/resources — *not* the
   NSIS/MSI output). The exe name comes from the `[[bin]] name` in `Cargo.toml`; it must
   equal the manifest's `Executable=` below, and a `target/` dir carrying a stale `app.exe`
   from before the 0.3.0 rename should be cleaned first so the wrong binary can't be staged.
4. **Author `AppxManifest.xml`** next to the staged binaries:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">

  <!-- Must match the Partner Center identity values exactly. -->
  <Identity Name="1234AidenPaleczny.Anchor" Publisher="CN=ABCD1234-..." Version="1.0.0.0" />

  <Properties>
    <DisplayName>Anchor</DisplayName>
    <PublisherDisplayName>Aiden Paleczny</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0"
                        MaxVersionTested="10.0.22631.0" />
  </Dependencies>

  <Capabilities>
    <Capability Name="internetClient" />              <!-- first-run download -->
    <rescap:Capability Name="runFullTrust" />         <!-- load pdfium.dll, spawn llama-server/tesseract -->
  </Capabilities>

  <Applications>
    <Application Id="Anchor" Executable="Anchor.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Anchor" Description="Local-first AI data extraction"
          Square150x150Logo="Assets\Square150x150Logo.png"
          Square44x44Logo="Assets\Square44x44Logo.png" BackgroundColor="transparent">
        <uap:DefaultTile Wide310x150Logo="Assets\Square310x310Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
```

   Tile assets already exist in [`app/src-tauri/icons/`](../app/src-tauri/icons/)
   (`Square*Logo.png`, `StoreLogo.png`) — copy them into `Assets\`.

   `runFullTrust` is a *restricted* capability you justify at submission (routine for
   desktop apps): it's what lets the packaged process load the downloaded `pdfium.dll` and
   `CreateProcess` the downloaded `llama-server.exe`/`tesseract.exe`. Child processes run
   without package identity, which is fine.

5. **Pack:**
   ```powershell
   makepri createconfig /cf priconfig.xml /dq en-US
   makepri new /pr . /cf priconfig.xml
   makeappx pack /d . /p Anchor_1.0.0.0.msix
   ```
6. **Run the Windows App Certification Kit (WACK)** and fix everything it reports.
7. **Self-sign for sideload testing only** (never submit a self-signed package):
   ```powershell
   New-SelfSignedCertificate -Type Custom -Subject "CN=ABCD1234-..." `
     -KeyUsage DigitalSignature -CertStoreLocation "Cert:\CurrentUser\My" `
     -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
   signtool sign /fd SHA256 /a /f test-cert.pfx /p <pwd> Anchor_1.0.0.0.msix
   ```
   Install the cert into **Trusted People** on the test machine, then sideload with
   `Add-AppxPackage`.

### 6.3 Policy compliance — status per requirement

| Policy | Requirement | Status |
|---|---|---|
| **10.2.4** dependency disclosure | Non-integrated components delivering primary functionality must be disclosed **at the beginning of the description**. | 🔶 Draft text ready (§6.5) — paste at submission. |
| **10.2.2** no undisclosed dynamic code | Downloads *are* the described functionality; each is SHA-256-pinned and verified before use (`download_file` in [setup.rs](../app/src-tauri/src/setup.rs)). See the note below on what "pinned" now rests on. | ✅ Compliant — say so in cert notes. |
| **10.2.9** standalone installer | The installer installs a complete runnable app; the 3.5 GB fetch happens at *first run*, not during install. **Never move app code into a post-install fetch.** | ✅ Compliant. |
| **10.2** signing | Store signs the MSIX on ingestion. (Fallback path requires the installer *and every installed PE* to be signed — see §5.1.) | ✅ N/A for MSIX. |
| **10.2.7** clean uninstall | Must enable removal of everything, incl. the downloaded GB. | ✅ In-app *Remove all data and quit* (N5); 🔶 confirm what MSIX uninstall clears on a VM (§6.4). |
| **10.5.1** privacy policy URL | Mandatory for Win32/packaged products. | ✅ Live at https://anchor.aidenpaleczny.com/privacy |
| **11.16** generative-AI | Declare live GenAI in Partner Center + listing; provide a report path. | ✅ In-app note + EULA §4 + `SECURITY.md` contact exist; 🔶 tick the declaration at submission. |
| **11.2** licensing/attribution | Third-party components properly licensed and attributed. | ✅ `NOTICES.md` + in-app Licenses screen + `/licenses`. Reconciled 2026-08-04: §3 matches `cargo metadata` by name and version (718/718), and §2.1 now covers the bundled Inter / Source Serif 4 (OFL-1.1, full text in Appendix E) and Material Symbols (Apache-2.0) — previously unlisted while this row claimed ✅. Qwen verified Apache-2.0 (base + unsloth GGUF) for R2 redistribution. |
| **10.1.1** title/metadata accuracy | Unique title; state limitations (English-only OCR, one-time download, CPU works but slower). | 🔶 Reserve the name; listing copy at submission. |
| **10.3.1** login | No account required — state in cert notes. | ✅ |
| **10.4.1** graceful on incompatible hardware | Must degrade/message, not fail silently, on a GPU-less VM. | ✅ Wizard selects the CPU backend; re-verify per §7. |
| **11.11** age rating | IARC questionnaire → Everyone / PEGI 3. | 🔶 At submission. |

**What the 10.2.2 claim rests on now that models are catalog data.** Which models an install downloads is derived from the chosen pipeline preset rather than from a fixed list ([design.md](design.md) §7.1), so "every download is pinned" had to stop being a property of one hand-maintained array. It is now enforced by a build-time test: the catalog declares that a model needs a file, `MODEL_ASSETS` in [setup.rs](../app/src-tauri/src/setup.rs) pins what bytes that file may be, and `every_catalog_model_file_has_pinned_bytes_and_vice_versa` asserts the two cover each other **exactly**. A model added without a pin fails `cargo test`; an orphaned pin fails the same way. Empty digests are rejected outright, because `verify_file_hash` skips them by design. The catalog itself is compiled Rust constants, not a user-editable manifest — that is deliberate and is part of this claim.

**One carve-out, and it is not a download.** Settings ▸ AI model lets a user point Anchor at a GGUF **already on their own disk** (design.md §7.5). Nothing is fetched: the app accepts only an absolute path to an existing local file whose contents begin with the `GGUF` magic bytes, and it explicitly refuses any URL. The in-app text states that a user-supplied model is not verified. This is the user running their own file on their own machine — the same category as opening a document — and it introduces no code path that downloads anything unpinned. If a certification reviewer asks, that is the answer: there is exactly one way bytes arrive over the network, it is `download_file`, and it verifies against a constant compiled into the binary.

### 6.4 The uninstall/AppData problem (10.2.7)

MSIX uninstall removes the package, but the wizard's downloads live in the (virtualized)
app-data directory and may persist. Leaving multiple GB behind is exactly what this policy
targets. Fix order: (1) ✅ in-app **"Remove all downloaded data"** in Settings — N5, shipped
as *Remove all data and quit*; and (2) confirm during VM testing what MSIX uninstall
actually clears; disclose whatever remains in the listing, pointing at the in-app action.

### 6.5 Listing copy to paste

**First line of the description (10.2.4):**

> **Note:** On first launch, Anchor downloads required components (the Tesseract OCR
> engine, a llama.cpp model server, the PDFium renderer, and a ~3.4 GB local AI model)
> into your user folder. An internet connection is needed once, for this initial setup;
> after that, all document processing runs fully offline on your device.

**Generative-AI line:** "Anchor uses a local generative-AI model to structure your
documents; review AI output for accuracy."

**Certification notes:** what the app does; the first-run download (what/size/why/where);
that every download is **SHA-256-verified** before use; that **no account or login** is
required; that a **CPU-only machine** (no GPU) can complete an extraction, just slower;
expected time to a first successful extraction; and the `runFullTrust` justification —
*"full-trust desktop application that loads a downloaded PDF-rendering library and runs a
local model server as child processes."*

### 6.6 Store risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Load/spawn or AppData path fails under package identity | **Medium** | VM-test early (§7); `runFullTrust`; fall back to 10.2.9 rather than fighting the package. |
| Reviewer reads the 3.5 GB download as undisclosed dynamic code (10.2.2) | Medium | Disclosure first line + cert notes + SHA-256 verification. |
| MSIX packaging effort (no Tauri bundler) | Medium | Budget the manual `makeappx` pass; §6.2. |
| AppData not removed on uninstall (10.2.7) | Low | ✅ N5 shipped (in-app *Remove all data and quit*); confirm the MSIX side on a VM and disclose it. |
| Name "Anchor" already taken (10.1.1) | Medium | Reserve early; fallback title ready. |

### 6.7 Shipping a Store update
Bump `version` in `tauri.conf.json`, `package.json`, **and** the manifest's
`Identity Version`; rebuild; repack; submit. The Store pushes it to installed users —
nothing to re-host.

---

## 7. Pre-publish verification

Run against the **built artifacts from the draft release**, not a dev build. Use throwaway
VMs snapshotted clean so every run is a true first install. These are
[TEST_PLAN.md](TEST_PLAN.md) §7 journeys and §8 crash matrix executed against a real
installer; the `e2e/` + tauri-driver setup can automate the extraction loop, while
install/uninstall/path checks stay manual.

**Matrix**

| Environment | Why |
|---|---|
| **Windows 11, clean, no GPU** | The realistic reviewer/most-users environment; CPU extraction must complete. |
| **Windows 10 22H2, clean, no GPU** | Oldest supported target; WebView2 runtime presence. |
| **Windows 11 + GPU** (passthrough or bare metal) | CUDA path; verify GPU offload engages. |
| **macOS Apple Silicon, clean** | DMG opens (post-N2: with no Gatekeeper warning); Metal backend; full loop. |
| **Network-restricted, post-setup** | The local-first claim: extraction works with the network off. |

**Every run must verify**

- [ ] Install completes from the published artifact (and, for MSIX, one-click/silent).
- [ ] First-run wizard downloads ~3.5 GB, SHA-256 verifies, and **resume works** (kill the
      network mid-download, reconnect).
- [ ] `pdfium` loads and `llama-server`/`tesseract` spawn — the load/spawn check that also
      gates the MSIX decision.
- [ ] AppData path resolves consistently and holds the downloads (critical under MSIX).
- [ ] Full loop: upload → OCR → format table → click cell → highlight → export (CPU and GPU).
- [ ] Multi-page PDF + a corrupt page (per-page fault tolerance).
- [ ] Offline after setup: disconnect, restart, extract.
- [ ] Crash/recovery: kill `llama-server` mid-extraction → error surfaces, next launch reaps
      the orphan, cancelled/partial state recovers.
- [ ] Settings ▸ Data: *Remove all data and quit* empties the AppData folder (check the
      folder itself is gone, ~3.5 GB reclaimed), and *Reset Anchor* lands back in the wizard
      with a working database.
- [ ] Uninstall **after** that: confirm nothing of consequence remains, and note what the
      uninstaller leaves when run without the in-app removal first.
- [ ] Low-spec machine messages gracefully instead of failing silently (10.4.1).

---

## 8. Repo rename note

The repository is now `apalecz2/anchor`, and ✅ the working copy's `origin` now points at
`https://github.com/apalecz2/anchor.git` (verified 2026-08-05) rather than relying on
GitHub's permanent redirect from the old `DataExtractionAI` URL. The website and all
published links already use the new name. If a clone still has the old remote:

```bash
git remote set-url origin https://github.com/apalecz2/anchor.git
```

---

## 9. Deferred, with triggers

| Item | Trigger that makes it worth doing |
|---|---|
| **winget / Homebrew Cask** | After N2+N3 — both want signed artifacts. |
| **In-app auto-update** | After signing; or when users are on ≥2 versions behind. |
| **Enterprise hardening** (bundle signed native binaries so only model data downloads, Intune/winget deployment, offline provisioning, required-domains doc) | A managed-fleet/B2B customer. Don't build it for one developer on an open laptop. |
| **Intel Mac support** | Needs x86_64 llama-server + PDFium assets in R2 (`paths.rs::pdfium_spec`, `setup.rs::get_llama_server_spec`). Only with real demand. |
| **Linux packaging** | Code paths are best-effort placeholders today. |
| **Paid tier / licensing keys** | The Elastic License 2.0 choice already protects license-key-gated functionality; EULA §2 pre-drafts refund terms. Add Store/Stripe payment terms when you charge. |
| **Full DMCA §512 program** | Only if Anchor ever hosts user content (cloud sync, sharing, a web app). Today a copyright/takedown contact in `SECURITY.md` covers the realistic case. |

---

## 10. Portfolio checklist

The deployment story is most of the point of this doc; what a reviewer sees:

- [x] Public repo, Elastic-2.0 licensed, real README with a screenshot.
- [x] Green CI on every PR (frontend `tsc` + coverage-ratcheted Vitest; Rust fmt/clippy/tests
      on Windows + macOS) **and** a tag-driven release workflow.
- [x] Downloadable builds for both platforms from GitHub Releases.
- [x] A live marketing site with real legal pages.
- [ ] **Signed** downloads that install without a scary warning (N2, N3).
- [ ] Microsoft Store listing (N6).
- [ ] A short write-up of one hard problem — provenance matching, or the packaging/CSP
      debugging in [issues.md](issues.md) — the thing that becomes an interview story.
