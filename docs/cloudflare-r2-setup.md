# Cloudflare R2 Setup Guide

This document walks through provisioning a Cloudflare R2 bucket, uploading all required assets, and wiring the URL back into the app.

---

## Overview

The first-run setup wizard downloads ~3.5 GB of assets at runtime rather than bundling them with the installer. All assets are served from a single Cloudflare R2 bucket. The Rust backend reads one constant (`R2_BASE` in [setup.rs](../app/src-tauri/src/setup.rs)) and constructs every download URL from it. It is currently set to `https://anchor-assets.aidenpaleczny.com`.

**Assets served from R2:**

Sizes are the actual R2 object `Content-Length` (verified 2026-06-16) and match `size_bytes` in the asset manifest.

| Asset | Size | R2 path |
|---|---|---|
| llama.cpp release zip (Windows CPU) | ~17 MB | `binaries/llama-bin-win-cpu-x64.zip` |
| llama.cpp release zip (Windows CUDA) | ~261 MB | `binaries/llama-bin-win-cuda-x64.zip` |
| CUDA runtime zip (Windows CUDA only) | ~391 MB | `binaries/cudart-llama-bin-win-cuda-x64.zip` |
| llama.cpp release tarball (macOS Apple Silicon) | ~10.5 MB | `binaries/llama-bin-macos-arm64.tar.gz` |
| PDFium (Windows) | ~3.8 MB | `binaries/pdfium-win-x64.tgz` |
| PDFium (macOS) | ~3.5 MB | `binaries/pdfium-mac-arm64.tgz` |
| Tesseract + DLLs (Windows) | ~38 MB | `windows/tesseract.zip` |
| Tesseract (macOS) | ~5.7 MB | `macos/tesseract.zip` |
| Vision projector (mmproj) | ~672 MB | `models/mmproj-F16.gguf` |
| Qwen language model | ~2.74 GB | `models/Qwen3.5-4B-Q4_K_M.gguf` |

The llama.cpp archives are the **unmodified release artifacts** from GitHub — no repackaging (Windows `.zip`, macOS `.tar.gz`; Linux is a later addition and not provisioned now). The app downloads the archive and extracts the server binary + all its shared libraries into `{AppData}/binaries/`. To update llama.cpp, download the new release archive, rename it to strip the build tag (keep the extension), and overwrite the R2 object.

---

## Step 1 — Create a Cloudflare account and R2 bucket

1. Log in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. In the left sidebar click **R2 Object Storage** → **Create bucket**.
3. Name the bucket (e.g. `anchor-assets`).
4. Select the region closest to your primary user base (or `Auto`).
5. Click **Create bucket**.

---

## Step 2 — Enable public access

The app downloads files over plain HTTPS with no authentication. You need public read access on the bucket.

### Option A — Custom domain (recommended for production)

1. Open the bucket → **Settings** tab → **Custom Domains**.
2. Click **Connect Domain** and enter the domain you control (this project uses `anchor-assets.aidenpaleczny.com`).
3. Cloudflare automatically creates the DNS record if the domain uses Cloudflare DNS.
4. Wait for the domain to show **Active**.
5. Your base URL will be `https://anchor-assets.aidenpaleczny.com` (or whatever you set) — this is the value of `R2_BASE` in `setup.rs`.

### Option B — r2.dev public URL (development/testing only)

1. Open the bucket → **Settings** tab → **Public Access**.
2. Toggle **Allow Access** on under the `r2.dev` subdomain section.
3. Copy the generated URL (looks like `https://pub-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.r2.dev`).
4. Use this as your `R2_BASE` temporarily. Switch to a custom domain before shipping.

---

## Step 3 — Configure CORS

The Tauri app downloads via the Rust `reqwest` client (not a browser), so CORS is not strictly required. However, if you ever serve these assets to a web client or test with `curl` from a browser extension, set a permissive policy now.

1. Open the bucket → **Settings** → **CORS Policy**.
2. Click **Add Rule** and paste:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

3. Save.

---

## Step 4 — Install Wrangler CLI

Wrangler is the official Cloudflare CLI. Use it to upload assets from the command line.

```bash
npm install -g wrangler
wrangler login
```

`wrangler login` opens a browser; approve the OAuth prompt. Your credentials are saved at `~/.wrangler/config/default.toml`.

Verify access:

```bash
wrangler r2 bucket list
```

Your new bucket should appear in the list.

---

## Step 5 — Obtain the llama.cpp release archives

Download the pre-built release archives from the llama.cpp GitHub releases page — **do not unzip or repackage them**. Only Windows and macOS are provisioned for now (Linux is a later addition). Note Windows ships as `.zip`, macOS as `.tar.gz`:

**URL:** https://github.com/ggerganov/llama.cpp/releases

Pick a single release tag and use it consistently across all platforms. Rename each archive to strip the build tag (and CUDA version) so the R2 object key stays stable across llama.cpp updates — **keep the original file extension** (`.zip` or `.tar.gz`):

| Release artifact | Rename to (R2 key under `binaries/`) |
|---|---|
| `llama-b9596-bin-win-cpu-x64.zip` | `llama-bin-win-cpu-x64.zip` |
| `llama-b9596-bin-win-cuda-13.3-x64.zip` | `llama-bin-win-cuda-x64.zip` |
| `cudart-llama-bin-win-cuda-13.3-x64.zip` | `cudart-llama-bin-win-cuda-x64.zip` |
| `llama-b9596-bin-macos-arm64.tar.gz` | `llama-bin-macos-arm64.tar.gz` |

> **Currently pinned:** llama.cpp build **`b9596` (commit `18ef86ece`)** — the value recorded in `LLAMA_CPP_BUILD` in `setup.rs` and surfaced in each manifest entry's `version` field. Since the rename strips the tag, this constant is the audit record of what the pinned SHA-256s correspond to; update it in lockstep when you refresh the archives (the build is recoverable any time via `llama-server --version`).

> The `cudart-*` zip (CUDA runtime DLLs) is listed on the same release page and is **required** for the Windows CUDA backend — the CUDA build zip does not bundle the runtime.

That's the entire update procedure: download, rename, upload to `binaries/`. The app extracts each archive into `{AppData}/binaries/`, so the server executable and every shared library it needs land in one folder automatically. The backend handles both `.zip` and `.tar.gz` and flattens the macOS archive's nested `build/bin/` layout, so no manual repackaging is ever needed.

---

## Step 6 — Build the Tesseract zip archives

The app extracts each Tesseract zip into `{AppData}/com.aidenpaleczny.anchor/tesseract/`. After extraction the app expects this layout:

```
tesseract/
├── tesseract[.exe]          ← main executable
├── tessdata/
│   └── eng.traineddata      ← English language model
└── *.dll                    ← Windows only: all DLLs Tesseract depends on
```

The zip must contain this structure, but it **may be wrapped in any number of enclosing folders** (e.g. a top-level `tesseract-w64/` folder is fine). On extraction the backend locates the folder that actually contains the `tesseract[.exe]` binary and lifts its whole subtree — including `tessdata/` — into `tesseract/`. So you can zip the installer's output folder as-is without flattening it first.

### Windows

1. Download the Tesseract Windows installer from https://github.com/UB-Mannheim/tesseract/releases (e.g. `tesseract-ocr-w64-setup-5.x.x.exe`).
2. Install it locally (or use 7-Zip to extract the installer without running it).
3. From the installed directory, collect:
   - `tesseract.exe`
   - All `.dll` files in the same folder (`leptonica*.dll`, `tesseract*.dll`, etc.)
   - `tessdata/eng.traineddata`
4. Zip them preserving the folder structure shown above:

```powershell
# From inside the Tesseract install dir
Compress-Archive -Path tesseract.exe, *.dll, tessdata -DestinationPath tesseract.zip
```

5. Verify: unzip to a temp folder and confirm the layout matches the tree above.

### macOS

> **Status:** the macOS Tesseract zip is **built, uploaded to R2 (`macos/tesseract.zip`), and pinned** in `get_tesseract_spec`. The procedure below documents how that package is produced; the `tools/package-tesseract-macos.sh` helper it references is not committed to the repo, so reproduce the steps manually (or re-add the script) if you need to rebuild it.

Do **not** just `cp $(which tesseract)`. The Homebrew binary dynamically links against
`/opt/homebrew` dylibs (libtesseract, libleptonica, libwebp, libsharpyuv, …) that don't
exist on a user's machine, so a bare copy dies at launch with `dyld: Library not loaded`.
A correct package must bundle every dependency next to the binary, rewrite all load paths
to `@loader_path`, ad-hoc re-sign (required on Apple Silicon), and lay out the exact
`tesseract` + `tessdata/eng.traineddata` structure the app expects (the same layout shown
above for Windows). The plan is a `tools/package-tesseract-macos.sh` helper to automate
this end-to-end:

```bash
brew install tesseract
# planned helper (not yet committed):
# tools/package-tesseract-macos.sh eng ./tesseract.zip
```

The helper would verify the result is fully self-contained before writing the zip. To
bundle a different language, pass its code (e.g. `deu`) — install it first with
`brew install tesseract-lang`.

---

## Step 7 — Obtain the GGUF model files

The app uses:

- **Qwen3.5-4B-Q4_K_M.gguf** (~2.74 GB) — quantized Qwen 3.5 4B language model
- **mmproj-F16.gguf** (~672 MB) — vision projector

Both come from the `unsloth/Qwen3.5-4B-GGUF` repository on HuggingFace. The `HF_MODEL_URL` and `HF_MMPROJ_URL` constants in [setup.rs](../app/src-tauri/src/setup.rs) are **already set** — and pinned to an exact commit revision (`@e87f176…`, not `main`) so a re-quant can't change the bytes underneath the SHA-256 pins. They serve as the fallback if the R2 primary is unreachable. Only revisit them if you re-pin to a different model build (update the revision in both URLs to match the new SHA-256s).

> You can also upload the GGUF files directly to R2 as the primary source (recommended to avoid HuggingFace rate limits). For very large files use multipart upload via the Cloudflare dashboard or `rclone`.

---

## Step 8 — Compute SHA-256 checksums

After collecting all files, compute a SHA-256 hash for each. These will be pinned in the asset manifest in [setup.rs](../app/src-tauri/src/setup.rs) in Step 11.

**PowerShell (Windows):**

**PowerShell (Windows):**

```powershell
Get-FileHash llama-bin-win-cpu-x64.zip -Algorithm SHA256
Get-FileHash llama-bin-win-cuda-x64.zip -Algorithm SHA256
Get-FileHash cudart-llama-bin-win-cuda-x64.zip -Algorithm SHA256
Get-FileHash tesseract.zip -Algorithm SHA256
Get-FileHash mmproj-F16.gguf -Algorithm SHA256
Get-FileHash Qwen3.5-4B-Q4_K_M.gguf -Algorithm SHA256
```

**Bash (macOS):**

```bash
sha256sum llama-bin-macos-arm64.tar.gz tesseract.zip mmproj-F16.gguf Qwen3.5-4B-Q4_K_M.gguf
```

Record all hashes in a scratchpad — you'll need them in Step 11.

---

## Step 9 — Upload all assets to R2

Create a staging directory on your machine that mirrors the exact R2 path structure:

```
upload/
├── binaries/
│   ├── llama-bin-win-cpu-x64.zip
│   ├── llama-bin-win-cuda-x64.zip
│   ├── cudart-llama-bin-win-cuda-x64.zip
│   └── llama-bin-macos-arm64.tar.gz
├── windows/
│   └── tesseract.zip
├── macos/
│   └── tesseract.zip
└── models/
    ├── mmproj-F16.gguf
    └── Qwen3.5-4B-Q4_K_M.gguf
```

Upload the entire tree with Wrangler:

```bash
# Upload everything (run from the directory containing the upload/ folder)
wrangler r2 object put anchor-assets/binaries/llama-bin-win-cpu-x64.zip          --file upload/binaries/llama-bin-win-cpu-x64.zip
wrangler r2 object put anchor-assets/binaries/llama-bin-win-cuda-x64.zip         --file upload/binaries/llama-bin-win-cuda-x64.zip
wrangler r2 object put anchor-assets/binaries/cudart-llama-bin-win-cuda-x64.zip  --file upload/binaries/cudart-llama-bin-win-cuda-x64.zip
wrangler r2 object put anchor-assets/binaries/llama-bin-macos-arm64.tar.gz       --file upload/binaries/llama-bin-macos-arm64.tar.gz
wrangler r2 object put anchor-assets/windows/tesseract.zip                       --file upload/windows/tesseract.zip
wrangler r2 object put anchor-assets/macos/tesseract.zip                         --file upload/macos/tesseract.zip
wrangler r2 object put anchor-assets/models/mmproj-F16.gguf                      --file upload/models/mmproj-F16.gguf
wrangler r2 object put anchor-assets/models/Qwen3.5-4B-Q4_K_M.gguf              --file upload/models/Qwen3.5-4B-Q4_K_M.gguf
```

Replace `anchor-assets` with your actual bucket name.

For the large GGUF files (2.7 GB) Wrangler may be slow. As an alternative use `rclone` with the R2 S3-compatible API:

```bash
# Configure rclone once
rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=YOUR_R2_ACCESS_KEY_ID \
  secret_access_key=YOUR_R2_SECRET_ACCESS_KEY \
  endpoint=https://ACCOUNT_ID.r2.cloudflarestorage.com

# Then copy
rclone copy upload/models/ r2:anchor-assets/models/ --progress
```

R2 API credentials are created under **R2 → Manage R2 API Tokens** in the Cloudflare dashboard. Grant **Object Read & Write** for the specific bucket.

---

## Step 10 — Verify the uploads are publicly accessible

After uploading, test each URL with curl (or a browser) before updating the app:

```bash
# The project's R2_BASE (replace if you provisioned your own domain)
R2_BASE="https://anchor-assets.aidenpaleczny.com"

curl -I "$R2_BASE/binaries/llama-bin-win-cpu-x64.zip"
curl -I "$R2_BASE/windows/tesseract.zip"
curl -I "$R2_BASE/models/mmproj-F16.gguf"
curl -I "$R2_BASE/models/Qwen3.5-4B-Q4_K_M.gguf"
```

All should return `HTTP/2 200` with a `content-length` header matching the file size.

---

## Step 11 — Update the app constants

All asset constants live in [app/src-tauri/src/setup.rs](../app/src-tauri/src/setup.rs) (near the top of the file, and in the `get_llama_server_spec()` / `get_tesseract_spec()` / `get_asset_manifest()` functions). For the current project these are **already populated** — this step matters only if you are re-provisioning your own bucket or re-pinning new asset versions.

### 11a — Set R2_BASE

`R2_BASE` is currently:

```rust
const R2_BASE: &str = "https://anchor-assets.aidenpaleczny.com";
```

If you provision your own bucket under a different domain, replace it with your public URL.

### 11b — HuggingFace fallback URLs

`HF_MODEL_URL` / `HF_MMPROJ_URL` are already set and pinned to a commit revision of `unsloth/Qwen3.5-4B-GGUF` (see Step 7). Only change them if you re-pin to a different model build — keep them pinned to an exact revision, never `main`.

### 11c — Pin SHA-256 checksums

The `sha256` field on each asset is pinned in `get_llama_server_spec()`, `get_tesseract_spec()`, and `get_asset_manifest()`. When pinning a new asset, replace its `sha256` with the hash recorded in Step 8, for example:

```rust
// In get_asset_manifest — mmproj entry
let mmproj = AssetManifestEntry {
    asset_id:   "mmproj_gguf".into(),
    // ...
    sha256:     "abc123def456...".into(),   // ← 64 hex chars
    // ...
};
```

`verify_file_hash` treats an empty sha256 as "skip verification" in **debug builds only** — in a release build an empty/unpinned hash is rejected outright, so an unverified binary never runs in production. The only intentionally-empty hashes today are the Linux assets (a later addition).

### 11d — Record the version

Each manifest entry carries a `version` field for audit. When you re-pin, update it alongside the SHA-256: `LLAMA_CPP_BUILD` (currently `b9596 (18ef86ece)`) for the llama-server/cudart entries, and `QWEN_MODEL_REVISION` (`unsloth/Qwen3.5-4B-GGUF@e87f176`) for the GGUFs. The llama.cpp build is recoverable any time via `llama-server --version`.

---

## Step 12 — Build and test the setup wizard

```bash
cd app
npm run tauri dev
```

The app should open the setup wizard on first launch (or after clearing the `{AppData}/com.aidenpaleczny.anchor/` directory). The wizard is **Welcome → (Configuration, Custom path only) → Install → Complete** (hardware is probed in the background on Welcome; download/verify/extract all happen in the single Install step). Walk through it and confirm:

- [ ] Hardware probe completes and the recommended backend is offered
- [ ] The Install step lists every asset with correct sizes and an overall progress bar + time estimate
- [ ] Progress advances during download; "Show details" reveals per-asset progress
- [ ] Files land in the correct `{AppData}/com.aidenpaleczny.anchor/` subdirectories
- [ ] SHA-256 verification passes for all assets (verified incrementally as they stream)
- [ ] The main app launches after the wizard completes

To reset the wizard during testing:

```powershell
# Windows
Remove-Item -Recurse "$env:APPDATA\com.aidenpaleczny.anchor" -Force
```

```bash
# macOS
rm -rf ~/Library/Application\ Support/com.aidenpaleczny.anchor
```

---

## Step 13 — Ship the Surya + oar-ocr assets (lift the debug-only gates)

> **⚠️ Surya's half of this step is on hold — do not execute it.** After this guide was
> written, two things changed: (1) a real read of Surya's license found a modified
> OpenRAIL-M grant with a competing-product ban carrying no revenue exemption, a
> share-alike clause whose text reaches Anchor's own *output*, and a mandatory pass-through
> onto Anchor's own EULA — none of which `NOTICES.md`/`EULA.md` account for, and none of
> which is resolved; (2) the real `e2e/eval` harness found Surya's grid step made no
> measurable difference paired with an LLM and was worse than the LLM pipelines when used
> alone (see `catalog::SURYA_OCR_2`'s doc comment for the numbers). `tesseract-surya-qwen3.5-4b`,
> `oar-ocr-surya-qwen3.5-4b`, and `oar-ocr-surya-no-llm` were pulled from `catalog::PRESETS`
> entirely (2026-09-25, not just left `#[cfg(debug_assertions)]`) and are not selectable in
> any build. **The Surya-specific parts of 13a–13e below (files, upload commands, and the
> `PRESETS` snippet naming the three Surya presets) are kept only as a reference for if/when
> legal clears the license — they must not be run until then.** oar-ocr carries no such
> issue and remains actionable; do that half on its own.
>
> [!] Note there is no interface-level `SURYA_OCR_2` VS `oar-ocr` reason to feel time
> pressure — the model spec, the three presets, `Step::GroundGrid`, and `pipeline/surya.rs`
> all stay in the codebase as tested code either way, so there's nothing decaying while
> this waits on legal review.

Two engines added after the original provisioning above are still debug-only: **Surya**
(the table-grid model used by the on-hold "Accurate" presets, above) and **oar-ocr** (the
pure-Rust OCR engine used by the "Rust OCR" presets). Both are pinned with real SHA-256
hashes already — measured from files this project already downloaded and tested against —
but neither set of R2 objects exists yet, and oar-ocr additionally still self-downloads
from ModelScope at runtime instead of going through this app's manifest. **Only run
oar-ocr's half of what follows.**

**Do the two parts (per engine) in order** — upload and verify first; only drop a `#[cfg]`
gate once the URLs are confirmed live. A code change that ships a preset before its assets
exist on R2 is strictly worse than leaving it debug-only: it turns a known internal
limitation into a 404 in front of a real user, which is the exact failure this project
hit and fixed once already (see `docs/issues.md` § the `require_files_exist` post-mortem).

### 13a — Files needed and where they already are

You don't need to re-download or re-hash anything — every file below already exists on
this machine from earlier prototyping/testing, and every hash below is already pinned
in source. Just stage and upload them.

| Local source | Stage as (under `upload/`) | R2 destination | Size | SHA-256 |
|---|---|---|---|---|
| `prototypes/Surya/models/surya-2.gguf` | `models/surya-2.gguf` | `models/surya-2.gguf` | 1,266,400,864 B (1.3 GB) | `1f18abe17b1ed8b4e47ee9b1ad0e274c93daf5efbb6b29a04ff1712e37051e05` |
| `prototypes/Surya/models/surya-2-mmproj.gguf` | `models/surya-2-mmproj.gguf` | `models/surya-2-mmproj.gguf` | 204,986,688 B (205 MB) | `98c0563673b1657ff6d021d1e5f04af06cbf61bb40c63ac613e8bb71b42fb2c0` |
| `prototypes/Surya/models/chat_template.jinja` | `models/chat_template.jinja` | `models/chat_template.jinja` | 2,872 B | `86f17a85672e7f367b5e6c6de6f67f53ede0fba4abb3d67c583a6ef647c1aa85` |
| `~/.oar/pp-ocrv6_small_det.onnx` | `models/oar-ocr/pp-ocrv6_small_det.onnx` | `models/oar-ocr/pp-ocrv6_small_det.onnx` | 9,880,512 B (9.4 MB) | `d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e` |
| `~/.oar/pp-ocrv6_small_rec.onnx` | `models/oar-ocr/pp-ocrv6_small_rec.onnx` | `models/oar-ocr/pp-ocrv6_small_rec.onnx` | 21,159,378 B (20 MB) | `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634` |
| `~/.oar/ppocrv6_dict.txt` | `models/oar-ocr/ppocrv6_dict.txt` | `models/oar-ocr/ppocrv6_dict.txt` | 74,947 B | `b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d` |

Note the asymmetry: Surya's three files sit flat under `models/`; oar-ocr's sit nested
under `models/oar-ocr/`. That's simply how each was defined (`setup.rs`'s `MODEL_ASSETS`
for Surya, `get_oar_ocr_asset_specs` for oar-ocr) — upload to exactly the paths shown.

Before uploading, re-verify each local file's hash matches the table (cheap insurance
against a partial/corrupt local copy going live):

```powershell
# PowerShell
Get-FileHash "prototypes\Surya\models\surya-2.gguf" -Algorithm SHA256
Get-FileHash "prototypes\Surya\models\surya-2-mmproj.gguf" -Algorithm SHA256
Get-FileHash "prototypes\Surya\models\chat_template.jinja" -Algorithm SHA256
Get-FileHash "$env:USERPROFILE\.oar\pp-ocrv6_small_det.onnx" -Algorithm SHA256
Get-FileHash "$env:USERPROFILE\.oar\pp-ocrv6_small_rec.onnx" -Algorithm SHA256
Get-FileHash "$env:USERPROFILE\.oar\ppocrv6_dict.txt" -Algorithm SHA256
```

### 13b — Stage and upload

```bash
mkdir -p upload/models/oar-ocr
cp prototypes/Surya/models/surya-2.gguf          upload/models/
cp prototypes/Surya/models/surya-2-mmproj.gguf   upload/models/
cp prototypes/Surya/models/chat_template.jinja   upload/models/
cp ~/.oar/pp-ocrv6_small_det.onnx                upload/models/oar-ocr/
cp ~/.oar/pp-ocrv6_small_rec.onnx                upload/models/oar-ocr/
cp ~/.oar/ppocrv6_dict.txt                       upload/models/oar-ocr/

wrangler r2 object put anchor-assets/models/surya-2.gguf                    --file upload/models/surya-2.gguf
wrangler r2 object put anchor-assets/models/surya-2-mmproj.gguf             --file upload/models/surya-2-mmproj.gguf
wrangler r2 object put anchor-assets/models/chat_template.jinja             --file upload/models/chat_template.jinja
wrangler r2 object put anchor-assets/models/oar-ocr/pp-ocrv6_small_det.onnx --file upload/models/oar-ocr/pp-ocrv6_small_det.onnx
wrangler r2 object put anchor-assets/models/oar-ocr/pp-ocrv6_small_rec.onnx --file upload/models/oar-ocr/pp-ocrv6_small_rec.onnx
wrangler r2 object put anchor-assets/models/oar-ocr/ppocrv6_dict.txt        --file upload/models/oar-ocr/ppocrv6_dict.txt
```

(Surya's 1.3 GB file is the one candidate for `rclone` instead, per Step 9's note, if
Wrangler is slow.)

### 13c — Verify

```bash
R2_BASE="https://anchor-assets.aidenpaleczny.com"
curl -I "$R2_BASE/models/surya-2.gguf"
curl -I "$R2_BASE/models/surya-2-mmproj.gguf"
curl -I "$R2_BASE/models/chat_template.jinja"
curl -I "$R2_BASE/models/oar-ocr/pp-ocrv6_small_det.onnx"
curl -I "$R2_BASE/models/oar-ocr/pp-ocrv6_small_rec.onnx"
curl -I "$R2_BASE/models/oar-ocr/ppocrv6_dict.txt"
```

All six must return `HTTP/2 200` with `content-length` matching the table above before
touching any code below.

### 13d — Code changes, now that the assets are live

**Surya (`app/src-tauri/src/pipeline/catalog.rs`) — do not do this until legal clears the
license (see the warning at the top of this step).** Lifting the hold today is more than
un-`cfg`-ing a merge: the three Surya presets aren't just gated by build type anymore,
they're absent from `PRESETS` in every build. Once legal clears it, the real change is to
add them back to the (now un-gated, if oar-ocr's half of this guide already landed) array,
and delete the "on hold" doc comments on `SURYA_OCR_2`, `TESSERACT_SURYA_QWEN`,
`OAR_OCR_SURYA_QWEN`, and `OAR_OCR_SURYA_NO_LLM`:

```rust
// Before (current state):
pub const PRESETS: &[PipelinePreset] = &[OAR_OCR_QWEN, TESSERACT_QWEN];

// After:
pub const PRESETS: &[PipelinePreset] = &[
    OAR_OCR_SURYA_QWEN, TESSERACT_SURYA_QWEN, OAR_OCR_QWEN, TESSERACT_QWEN, OAR_OCR_SURYA_NO_LLM,
];
```

This also reopens the accuracy question this project already measured once and answered
"no" — the `e2e/eval` numbers in the warning above — so re-adding these presets should
come with either new evidence that changes that answer, or a product decision to ship
them anyway for a reason other than accuracy (e.g. speed, for `oar-ocr-surya-no-llm`
specifically).

Also revisit `DEFAULT_PRESET_ID`, which is currently cfg-split the same way (oar-ocr in
debug, Tesseract in release) — decide now whether oar-ocr becomes the real default or
stays an opt-in choice once it's no longer debug-only, and collapse that `#[cfg]` too.

**oar-ocr (`app/src-tauri/src/setup.rs`)** — reconnect the manifest function that already
exists but was never wired in. Remove the two `#[allow(dead_code)]` attributes on
`get_oar_ocr_asset_specs` and the three `OAR_OCR_*_FILENAME` constants, then:

```rust
// In required_assets():
if preset.uses_oar_ocr() {
    required.push("oar_ocr_det");
    required.push("oar_ocr_rec");
    required.push("oar_ocr_dict");
}

// In get_asset_manifest(), alongside the existing `tesseract` variable:
let oar_ocr = if preset.uses_oar_ocr() {
    get_oar_ocr_asset_specs(&data_dir)
} else {
    Vec::new()
};
// ...
assets.extend(tesseract);
assets.extend(oar_ocr);   // add this line back
assets.extend(models);

// In asset_installed():
"oar_ocr_det" => data_dir.join("models").join("oar-ocr").join(OAR_OCR_DET_FILENAME).exists(),
"oar_ocr_rec" => data_dir.join("models").join("oar-ocr").join(OAR_OCR_REC_FILENAME).exists(),
"oar_ocr_dict" => data_dir.join("models").join("oar-ocr").join(OAR_OCR_DICT_FILENAME).exists(),
```

(This is close to reverting the "quick test" fix from the earlier `pp-ocrv6_small_det.onnx
404` incident — that fix was correct *because* the files weren't uploaded yet; now that
they are, the original wizard-managed design is what should be reinstated.)

**oar-ocr (`app/src-tauri/src/ocr.rs`)** — the manifest change above makes the app
*download* the pinned files, but `run_oar_ocr` still has to actually *read from* them
instead of asking the crate to fetch its own copies by bare name. Thread `data_dir`
through the call chain and build real paths:

```rust
// ocr_image_to_page and run_oar_ocr both gain a `data_dir: &Path` parameter,
// passed from process_document_blocking's existing `data_dir` at both call sites
// (the PDF loop and the single-image branch).

fn run_oar_ocr(
    ocr_path: &Path,
    image_path: &Path,
    natural_width: i32,
    natural_height: i32,
    scale: f32,
    spec: &catalog::OarOcrSpec,
    data_dir: &Path,                                   // new
) -> Result<DocumentPageResult, String> {
    let models_dir = data_dir.join("models").join("oar-ocr");
    let engine = OAROCRBuilder::new(
        models_dir.join(spec.det_model).to_string_lossy().into_owned(),
        models_dir.join(spec.rec_model).to_string_lossy().into_owned(),
        models_dir.join(spec.dict).to_string_lossy().into_owned(),
    )
    .return_word_box(spec.word_box)
    .build()
    .map_err(|error| format!("failed to build oar-ocr pipeline: {error}"))?;
    // ...unchanged below...
```

Once this is in, oar-ocr no longer touches ModelScope at runtime at all — update its
doc comment (currently "resolved through oar-ocr's own auto-download... rather than the
paths setup.rs pins — that wiring is the remaining step") to say the wiring is done, and
consider removing the now-unused `auto-download` Cargo feature from `oar-ocr`'s entry in
`Cargo.toml` so there's no latent live-network code path left in the binary at all.

### 13e — Docs to update alongside the code

For oar-ocr (actionable now):

- **`docs/design.md` §5** — the "Debug only" row and the "auto-download... unpinned"
  framing for `oar-ocr-qwen3.5-4b` describe the now-superseded state.
- **`docs/todo.md`** — check off the oar-ocr R2-mirroring item.
- **`NOTICES.md` §1.7** — the line "fetched, on first use of an oar-ocr-grounded pipeline
  preset, by the `oar-ocr` crate's own `auto-download` feature directly from ModelScope"
  becomes false once 13d lands; update it to describe the app's own pinned download.
- **`CLAUDE.md`** — the top-of-file paragraph explicitly calls out oar-ocr's ModelScope
  path as "a separate, unpinned network path outside the wizard's own R2/pinned-manifest
  pipeline" — that sentence needs rewriting once it isn't true anymore.

For Surya (only once legal clears the license — see the warning at the top of this step):

- **`docs/design.md` §5** — the "Three more presets exist... not in `PRESETS` in *any*
  build" paragraph and the `SURYA_OCR_2`/`GroundGrid`/`Step::AssembleFromGrid` "on hold"
  callouts throughout §6 all describe the held state and would need rewriting.
- **`docs/todo.md`** — the "Pulled ... out of `catalog::PRESETS`" Completed entry would
  need a follow-up noting the hold was lifted and why (legal clearance obtained, and
  either new accuracy evidence or a non-accuracy reason to ship anyway).
- **`e2e/eval/presets.ts`** — add the three preset ids back to `PRESET_LABELS`.
- **`catalog.rs`, `executor.rs`, `setup.rs`** — reverse this session's "on hold" doc
  comments (search for "on hold" / "held out" in these three files) back to whatever
  reflects the real justification for shipping.

### 13f — Test and verify

```bash
cd app/src-tauri
cargo test --lib
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Then walk the setup wizard end-to-end (Step 12's checklist) with each of the five
presets selected in turn via the Custom path's preset picker, confirming each downloads,
verifies, and completes without touching ModelScope or any non-R2 host.

---

## File checklist

Before going to production, confirm every item below is complete:

- [ ] R2 bucket created and public access enabled
- [ ] Custom domain connected and Active (optional but recommended)
- [ ] CORS policy saved
- [ ] All llama.cpp release zips uploaded under `binaries/` (Windows CPU, Windows CUDA + cudart, macOS Apple Silicon)
- [ ] Both Tesseract zips uploaded (windows, macos)
- [ ] Both GGUF model files uploaded
- [ ] All uploads return HTTP 200 when accessed via curl
- [ ] `R2_BASE` constant correct in `setup.rs`
- [ ] `HF_MODEL_URL` and `HF_MMPROJ_URL` constants set in `setup.rs` (pinned to an exact revision)
- [ ] All `sha256` fields populated in the asset manifest (Linux assets may stay empty — later addition)
- [ ] Setup wizard tested end-to-end on at least one platform

**oar-ocr (Step 13, actionable now):**

- [ ] All 3 oar-ocr files uploaded (`models/oar-ocr/pp-ocrv6_small_det.onnx`, `models/oar-ocr/pp-ocrv6_small_rec.onnx`, `models/oar-ocr/ppocrv6_dict.txt`)
- [ ] All 3 return HTTP 200 with the correct `content-length` via curl
- [ ] `catalog.rs`'s `MODELS` and `PRESETS` `#[cfg(debug_assertions)]` split removed for the oar-ocr entries (and `DEFAULT_PRESET_ID`'s decided)
- [ ] `setup.rs`'s `get_oar_ocr_asset_specs` reconnected to `required_assets` / `get_asset_manifest` / `asset_installed`; `#[allow(dead_code)]` attributes removed
- [ ] `ocr.rs::run_oar_ocr` reads from `data_dir/models/oar-ocr/...` instead of asking the crate to auto-download by bare name
- [ ] `docs/design.md` §5, `docs/todo.md`, `NOTICES.md` §1.7, and `CLAUDE.md`'s opening paragraph updated to drop the "debug-only" / "unpinned ModelScope path" language for oar-ocr
- [ ] `cargo test --lib`, `cargo clippy -- -D warnings`, `cargo fmt --check` all pass
- [ ] `oar-ocr-qwen3.5-4b` (and the default preset) walked through the setup wizard end-to-end with no non-R2 network calls

**Surya (blocked — do not check any of these off until legal clears the license; see the warning at the top of Step 13):**

- [ ] Legal review of Surya's modified OpenRAIL-M license completed and documented (competing-product ban, output share-alike clause, mandatory EULA pass-through)
- [ ] Accuracy case re-established (the `e2e/eval` finding was that Surya's grid added nothing paired with an LLM and lost to it used alone) or a non-accuracy reason to ship anyway
- [ ] All 3 Surya files uploaded (`models/surya-2.gguf`, `models/surya-2-mmproj.gguf`, `models/chat_template.jinja`)
- [ ] All 3 return HTTP 200 with the correct `content-length` via curl
- [ ] `tesseract-surya-qwen3.5-4b`, `oar-ocr-surya-qwen3.5-4b`, and `oar-ocr-surya-no-llm` added back to `catalog::PRESETS`
- [ ] "On hold" doc comments in `catalog.rs`, `executor.rs`, and `setup.rs` reversed; `docs/design.md` §5/§6 and `e2e/eval/presets.ts` updated
- [ ] `cargo test --lib`, `cargo clippy -- -D warnings`, `cargo fmt --check` all pass
- [ ] All three Surya presets walked through the setup wizard end-to-end with no non-R2 network calls
