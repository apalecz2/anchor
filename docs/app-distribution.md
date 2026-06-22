# App Distribution via Cloudflare R2

This document covers building the Artifact installer, uploading it to R2, and linking to it from a website. The installer itself is small (< 20 MB) — the heavy assets (llama-server, Tesseract, models) are downloaded by the first-run wizard after installation using the same R2 bucket described in [cloudflare-r2-setup.md](cloudflare-r2-setup.md).

---

## Prerequisites

Before building a distributable release, make two changes to [`app/src-tauri/tauri.conf.json`](../app/src-tauri/tauri.conf.json):

**1. Set `productName`** — currently `"app"`, which becomes the installer filename and Windows app name:

```json
"productName": "Artifact",
```

**2. Bump `version`** — used in the installer filename and Windows Add/Remove Programs entry:

```json
"version": "1.0.0",
```

**3. Add the macOS signing block + entitlements file** — required so the notarized app can load and run the binaries the first-run wizard downloads into AppData (see [Step 2 → macOS](#macos--notarization-and-hardened-runtime) for the full explanation). Add a `macOS` block under `bundle`:

```json
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: Your Name (XXXXXXXXXX)",
    "entitlements": "entitlements.plist"
  }
}
```

Then create [`app/src-tauri/entitlements.plist`](../app/src-tauri/entitlements.plist):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- REQUIRED: lets the app dlopen libpdfium.dylib from AppData. Without this,
         hardened-runtime library validation refuses to load a dylib that isn't
         signed by our Team ID (pdfium is signed by Google), and PDF rendering
         fails at runtime with a code-signature error. -->
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <!-- Defensive: llama.cpp's Metal backend compiles GPU shaders at runtime.
         llama-server runs as a separate process and does not inherit these, but
         keeping them here is harmless and future-proofs loading any JIT library
         into the app process itself. -->
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
</dict>
</plist>
```

---

## Step 1 — Build the release installers

### Windows

Run on a Windows machine (or a Windows CI runner):

```powershell
cd app
npm run tauri build
```

Tauri produces installers in `app/src-tauri/target/release/bundle/`:

```
bundle/
  nsis/
    Artifact_1.0.0_x64-setup.exe     ← NSIS installer (recommended)
  msi/
    Artifact_1.0.0_x64_en-US.msi     ← MSI alternative
```

Use the NSIS `.exe` — it handles upgrades more gracefully and is the default Tauri target.

### macOS

Run on a Mac:

```bash
cd app
npm run tauri build
```

Output is in `app/src-tauri/target/release/bundle/`:

```
bundle/
  dmg/
    Artifact_1.0.0_aarch64.dmg       ← Apple Silicon
    Artifact_1.0.0_x64.dmg           ← Intel (if built on Intel or via cross-compile)
  macos/
    Artifact.app
```

---

## Step 2 — Code signing (do this before uploading)

Unsigned builds trigger OS security warnings. Users on Windows see a SmartScreen block; users on macOS see a Gatekeeper quarantine. Both require action before the app opens.

> **Why this app needs more than just a signed installer.** Unlike a self-contained app, Artifact ships a < 20 MB installer and the first-run wizard downloads the heavy binaries — `llama-server`, `tesseract`, and the PDFium shared library — into `{AppData}/com.aidenpaleczny.artifact/`. The app then **loads `libpdfium.dylib` / `pdfium.dll` into its own process** (via `pdfium-render`) and **spawns `llama-server` and `tesseract` as child processes** from that directory. Signing only the installer is not enough: the OS security model also governs whether the installed app is *allowed to load and execute those downloaded files at runtime*. The platform notes below cover both.

### Windows — Authenticode signing

You need a code signing certificate (EV or OV) from a CA such as DigiCert or Sectigo.

```powershell
signtool sign `
  /fd SHA256 `
  /tr http://timestamp.digicert.com `
  /td SHA256 `
  /f "path\to\certificate.pfx" `
  /p "certificate_password" `
  "Artifact_1.0.0_x64-setup.exe"
```

Tauri can invoke `signtool` automatically during the build if you set environment variables before running `npm run tauri build`:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "path\to\certificate.pfx"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "certificate_password"
```

**Downloaded binaries in AppData need no separate signing on Windows.** Windows has no equivalent of macOS library validation: a signed app can load `pdfium.dll` and spawn `llama-server.exe` / `tesseract.exe` from AppData regardless of whether those files are signed. They also do not pick up a Mark-of-the-Web (Zone.Identifier) tag, because the wizard writes them via a direct HTTP stream rather than through a browser/quarantine-aware API — so SmartScreen does not gate their first execution. Signing the installer and main executable is purely about SmartScreen reputation for the *download* the user runs; once installed, the runtime binaries just work. (Optionally Authenticode-sign `llama-server.exe` too if your AV/EDR policy flags unsigned executables, but it is not required for the app to function.)

### macOS — Notarization and hardened runtime

Apple requires notarization for any app distributed outside the Mac App Store. The Tauri CLI handles this if you supply the right environment variables before building:

```bash
export APPLE_ID="your@apple.id"
export APPLE_PASSWORD="app-specific-password"   # generated at appleid.apple.com
export APPLE_TEAM_ID="XXXXXXXXXX"               # from developer.apple.com
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (XXXXXXXXXX)"
```

Then `npm run tauri build` signs, notarizes, and staples the DMG automatically.

**This is where the entitlements from the Prerequisites matter.** Notarization forces the **hardened runtime**, and the hardened runtime turns on **library validation** by default: the app process may only load dynamic libraries signed by Apple or by *your* Team ID. PDFium is signed by Google, so the moment `pdfium-render` tries to `dlopen` `libpdfium.dylib` from AppData, the load is rejected with a code-signature error and PDF rendering breaks — even though the rest of the app is perfectly notarized. The `com.apple.security.cs.disable-library-validation` entitlement is what lifts that restriction so the third-party, downloaded library can be loaded. **Without that entitlement, a correctly notarized build still cannot render PDFs.** Tauri applies the `entitlements.plist` you configured in the Prerequisites during signing — confirm it is wired up before building.

**The child processes (`llama-server`, `tesseract`) are a separate concern.** They are not loaded into the app's address space, so library validation does not apply to them, and because the app `posix_spawn`s them directly (rather than launching via LaunchServices) Gatekeeper does not run a first-launch assessment or show a "developer cannot be verified" prompt. Two things still need to hold:

- **On Apple Silicon every executable must carry at least an ad-hoc signature or the kernel kills it on exec.** The upstream llama.cpp and Tesseract arm64 builds are already ad-hoc signed, so they run as-is. If you ever repackage them and strip the signature, re-sign before uploading: `codesign -s - --force <binary>`.
- **No quarantine flag is attached.** Like on Windows, the wizard streams these files to disk over HTTP, so they never receive a `com.apple.quarantine` xattr and are not Gatekeeper-quarantined. (If you sideload binaries by hand during testing and hit "cannot be opened because the developer cannot be verified," clear it with `xattr -dr com.apple.quarantine {AppData}/com.aidenpaleczny.artifact/`.)

If you skip notarization entirely, macOS users must right-click → Open the first time to bypass Gatekeeper. This is acceptable for early/beta releases but not for a public launch — and note that an unsigned/un-hardened build sidesteps the library-validation issue above, so the PDFium failure only surfaces once you *start* notarizing. Add the entitlements before your first notarized build, not after.

#### Verifying the signature and entitlements

After building, confirm the hardened runtime is on and the entitlement actually made it into the signature:

```bash
# Hardened runtime should appear in the flags line.
codesign -dvvv "app/src-tauri/target/release/bundle/macos/Artifact.app" 2>&1 | grep -i runtime

# The disable-library-validation key must be present.
codesign -d --entitlements - "app/src-tauri/target/release/bundle/macos/Artifact.app" 2>&1 | grep library-validation

# Confirm notarization stapled successfully.
xcrun stapler validate "app/src-tauri/target/release/bundle/dmg/Artifact_1.0.0_aarch64.dmg"
```

If `library-validation` does not appear, the entitlements file was not picked up — recheck the `bundle.macOS.entitlements` path in `tauri.conf.json` and rebuild.

---

## Step 3 — R2 path structure for releases

Store releases under a `releases/` prefix, versioned by tag. Keep a `latest/` prefix as a stable pointer for your website's download buttons.

```
releases/
  v1.0.0/
    windows/
      Artifact-1.0.0-x64-setup.exe
    macos/
      Artifact-1.0.0-aarch64.dmg
      Artifact-1.0.0-x64.dmg
  latest/
    windows/
      Artifact-setup.exe              ← copy of current release (not a redirect)
    macos/
      Artifact-aarch64.dmg
      Artifact-x64.dmg
```

The `latest/` copies are what your website links to. When you ship a new version, you upload to `releases/vX.Y.Z/` and then overwrite the `latest/` objects.

---

## Step 4 — Upload to R2

Rename the built files before uploading so the filenames match the R2 paths above.

```powershell
# Windows — rename first
Rename-Item "Artifact_1.0.0_x64-setup.exe" "Artifact-1.0.0-x64-setup.exe"

# Upload versioned copy
wrangler r2 object put artifact-assets/releases/v1.0.0/windows/Artifact-1.0.0-x64-setup.exe `
  --file Artifact-1.0.0-x64-setup.exe

# Overwrite latest pointer
wrangler r2 object put artifact-assets/releases/latest/windows/Artifact-setup.exe `
  --file Artifact-1.0.0-x64-setup.exe
```

```bash
# macOS
wrangler r2 object put artifact-assets/releases/v1.0.0/macos/Artifact-1.0.0-aarch64.dmg \
  --file Artifact_1.0.0_aarch64.dmg

wrangler r2 object put artifact-assets/releases/latest/macos/Artifact-aarch64.dmg \
  --file Artifact_1.0.0_aarch64.dmg
```

---

## Step 5 — Website download links

Point your download buttons directly at the `latest/` R2 URLs. This project's R2 domain is `artifact-assets.aidenpaleczny.com` (the same bucket the asset wizard uses); swap it if you host releases elsewhere:

```html
<!-- Windows -->
<a href="https://artifact-assets.aidenpaleczny.com/releases/latest/windows/Artifact-setup.exe">
  Download for Windows
</a>

<!-- macOS Apple Silicon -->
<a href="https://artifact-assets.aidenpaleczny.com/releases/latest/macos/Artifact-aarch64.dmg">
  Download for macOS (Apple Silicon)
</a>

<!-- macOS Intel -->
<a href="https://artifact-assets.aidenpaleczny.com/releases/latest/macos/Artifact-x64.dmg">
  Download for macOS (Intel)
</a>
```

---

## Step 6 — Verify downloads before going live

```bash
R2_BASE="https://artifact-assets.aidenpaleczny.com"

curl -I "$R2_BASE/releases/latest/windows/Artifact-setup.exe"
curl -I "$R2_BASE/releases/latest/macos/Artifact-aarch64.dmg"
```

Both should return `HTTP/2 200` with a `content-length` header. If you get 403, public access is not enabled on the bucket — revisit Step 2 of [cloudflare-r2-setup.md](cloudflare-r2-setup.md).

---

## Shipping a new version

1. Bump `version` in `tauri.conf.json`.
2. Build and sign installers on Windows and Mac.
3. Upload to `releases/vX.Y.Z/` paths.
4. Overwrite the `releases/latest/` objects.
5. No website changes needed — the download links are stable.

---

## Checklist

- [ ] `productName` set to `"Artifact"` in `tauri.conf.json`
- [ ] Version bumped in `tauri.conf.json`
- [ ] `bundle.macOS.entitlements` set and `entitlements.plist` created with `disable-library-validation`
- [ ] Windows installer built and signed with Authenticode
- [ ] macOS DMG(s) built and notarized (hardened runtime on)
- [ ] `codesign -d --entitlements -` confirms `disable-library-validation` is in the signature
- [ ] First-run wizard completes and a PDF renders on a clean Mac (verifies pdfium loads under the hardened runtime)
- [ ] Versioned copies uploaded to `releases/vX.Y.Z/`
- [ ] `latest/` pointers overwritten
- [ ] All download URLs return HTTP 200 via curl
- [ ] Download links on website tested end-to-end (download → install → first-run wizard completes)
