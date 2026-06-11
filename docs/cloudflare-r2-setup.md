# Cloudflare R2 Setup Guide

This document walks through provisioning a Cloudflare R2 bucket, uploading all required assets, and wiring the URL back into the app.

---

## Overview

The first-run setup wizard downloads ~3.5 GB of assets at runtime rather than bundling them with the installer. All assets are served from a single Cloudflare R2 bucket. The Rust backend reads one constant (`R2_BASE` in [lib.rs](../app/src-tauri/src/lib.rs)) and constructs every download URL from it.

**Assets served from R2:**

| Asset | Size | R2 path |
|---|---|---|
| llama.cpp release zip (Windows CPU) | ~17 MB | `binaries/llama-bin-win-cpu-x64.zip` |
| llama.cpp release zip (Windows CUDA) | ~160 MB | `binaries/llama-bin-win-cuda-x64.zip` |
| CUDA runtime zip (Windows CUDA only) | ~400 MB | `binaries/cudart-llama-bin-win-cuda-x64.zip` |
| llama.cpp release tarball (macOS Apple Silicon) | ~50 MB | `binaries/llama-bin-macos-arm64.tar.gz` |
| Tesseract + DLLs (Windows) | ~90 MB | `windows/tesseract.zip` |
| Tesseract (macOS) | ~15 MB | `macos/tesseract.zip` |
| Vision projector (mmproj) | ~656 MB | `models/mmproj-F16.gguf` |
| Qwen language model | ~2.7 GB | `models/Qwen3.5-4B-Q4_K_M.gguf` |

The llama.cpp archives are the **unmodified release artifacts** from GitHub — no repackaging (Windows/Linux `.zip`, macOS `.tar.gz`). The app downloads the archive and extracts the server binary + all its shared libraries into `{AppData}/binaries/`. To update llama.cpp, download the new release archive, rename it to strip the build tag (keep the extension), and overwrite the R2 object.

---

## Step 1 — Create a Cloudflare account and R2 bucket

1. Log in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. In the left sidebar click **R2 Object Storage** → **Create bucket**.
3. Name the bucket (e.g. `artifact-assets`).
4. Select the region closest to your primary user base (or `Auto`).
5. Click **Create bucket**.

---

## Step 2 — Enable public access

The app downloads files over plain HTTPS with no authentication. You need public read access on the bucket.

### Option A — Custom domain (recommended for production)

1. Open the bucket → **Settings** tab → **Custom Domains**.
2. Click **Connect Domain** and enter the domain you control (e.g. `r2.artifact-app.com`).
3. Cloudflare automatically creates the DNS record if the domain uses Cloudflare DNS.
4. Wait for the domain to show **Active**.
5. Your base URL will be `https://r2.artifact-app.com` (or whatever you set).

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

Download the pre-built release archives from the llama.cpp GitHub releases page — **do not unzip or repackage them**. Note Windows/Linux ship as `.zip`, macOS as `.tar.gz`:

**URL:** https://github.com/ggerganov/llama.cpp/releases

Pick a single release tag and use it consistently across all platforms. Rename each archive to strip the build tag (and CUDA version) so the R2 object key stays stable across llama.cpp updates — **keep the original file extension** (`.zip` or `.tar.gz`):

| Release artifact | Rename to (R2 key under `binaries/`) |
|---|---|
| `llama-b9596-bin-win-cpu-x64.zip` | `llama-bin-win-cpu-x64.zip` |
| `llama-b9550-bin-win-cuda-13.3-x64.zip` | `llama-bin-win-cuda-x64.zip` |
| `cudart-llama-bin-win-cuda-13.3-x64.zip` | `cudart-llama-bin-win-cuda-x64.zip` |
| `llama-b9596-bin-macos-arm64.tar.gz` | `llama-bin-macos-arm64.tar.gz` |

> The `cudart-*` zip (CUDA runtime DLLs) is listed on the same release page and is **required** for the Windows CUDA backend — the CUDA build zip does not bundle the runtime.

That's the entire update procedure: download, rename, upload to `binaries/`. The app extracts each archive into `{AppData}/binaries/`, so the server executable and every shared library it needs land in one folder automatically. The backend handles both `.zip` and `.tar.gz` and flattens the macOS archive's nested `build/bin/` layout, so no manual repackaging is ever needed.

---

## Step 6 — Build the Tesseract zip archives

The app extracts each Tesseract zip into `{AppData}/DataExtractionAI/tesseract/`. After extraction the app expects this layout:

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

1. Install via Homebrew: `brew install tesseract`
2. Find the binary: `which tesseract` (usually `/opt/homebrew/bin/tesseract` on Apple Silicon)
3. Find tessdata: `brew --prefix tesseract`; tessdata is in `share/tessdata/`
4. Create the zip:

```bash
mkdir -p tesseract_pkg/tessdata
cp $(which tesseract) tesseract_pkg/tesseract
cp $(brew --prefix tesseract)/share/tessdata/eng.traineddata tesseract_pkg/tessdata/
cd tesseract_pkg && zip -r ../tesseract.zip .
```

---

## Step 7 — Obtain the GGUF model files

The app uses:

- **Qwen3.5-4B-Q4_K_M.gguf** (~2.7 GB) — quantized Qwen 3.5 4B language model
- **mmproj-F16.gguf** (~656 MB) — vision projector

Download both from HuggingFace. Find the correct repository for the Qwen3-4B GGUF variant (search HuggingFace for `Qwen3-4B-Q4_K_M GGUF`). Once you locate the repository, copy the two file download URLs and update the `HF_MODEL_URL` and `HF_MMPROJ_URL` constants in [lib.rs:361-364](../app/src-tauri/src/lib.rs#L361) with the exact HuggingFace resolve URLs as fallbacks.

> You can also upload the GGUF files directly to R2 as the primary source (recommended to avoid HuggingFace rate limits). For very large files use multipart upload via the Cloudflare dashboard or `rclone`.

---

## Step 8 — Compute SHA-256 checksums

After collecting all files, compute a SHA-256 hash for each. These will be pinned in the asset manifest in [lib.rs](../app/src-tauri/src/lib.rs) in Step 11.

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
wrangler r2 object put artifact-assets/binaries/llama-bin-win-cpu-x64.zip          --file upload/binaries/llama-bin-win-cpu-x64.zip
wrangler r2 object put artifact-assets/binaries/llama-bin-win-cuda-x64.zip         --file upload/binaries/llama-bin-win-cuda-x64.zip
wrangler r2 object put artifact-assets/binaries/cudart-llama-bin-win-cuda-x64.zip  --file upload/binaries/cudart-llama-bin-win-cuda-x64.zip
wrangler r2 object put artifact-assets/binaries/llama-bin-macos-arm64.tar.gz       --file upload/binaries/llama-bin-macos-arm64.tar.gz
wrangler r2 object put artifact-assets/windows/tesseract.zip                       --file upload/windows/tesseract.zip
wrangler r2 object put artifact-assets/macos/tesseract.zip                         --file upload/macos/tesseract.zip
wrangler r2 object put artifact-assets/models/mmproj-F16.gguf                      --file upload/models/mmproj-F16.gguf
wrangler r2 object put artifact-assets/models/Qwen3.5-4B-Q4_K_M.gguf              --file upload/models/Qwen3.5-4B-Q4_K_M.gguf
```

Replace `artifact-assets` with your actual bucket name.

For the large GGUF files (2.7 GB) Wrangler may be slow. As an alternative use `rclone` with the R2 S3-compatible API:

```bash
# Configure rclone once
rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=YOUR_R2_ACCESS_KEY_ID \
  secret_access_key=YOUR_R2_SECRET_ACCESS_KEY \
  endpoint=https://ACCOUNT_ID.r2.cloudflarestorage.com

# Then copy
rclone copy upload/models/ r2:artifact-assets/models/ --progress
```

R2 API credentials are created under **R2 → Manage R2 API Tokens** in the Cloudflare dashboard. Grant **Object Read & Write** for the specific bucket.

---

## Step 10 — Verify the uploads are publicly accessible

After uploading, test each URL with curl (or a browser) before updating the app:

```bash
# Replace with your actual R2_BASE
R2_BASE="https://r2.artifact-app.com"

curl -I "$R2_BASE/binaries/llama-bin-win-cpu-x64.zip"
curl -I "$R2_BASE/windows/tesseract.zip"
curl -I "$R2_BASE/models/mmproj-F16.gguf"
curl -I "$R2_BASE/models/Qwen3.5-4B-Q4_K_M.gguf"
```

All should return `HTTP/2 200` with a `content-length` header matching the file size.

---

## Step 11 — Update the app constants

Open [app/src-tauri/src/lib.rs](../app/src-tauri/src/lib.rs).

### 11a — Set R2_BASE

Find line 358 and replace the placeholder URL with your actual bucket URL:

```rust
// Before
const R2_BASE: &str = "https://r2.artifact-app.com";

// After — use your actual public URL
const R2_BASE: &str = "https://r2.artifact-app.com";  // ← replace if using a different domain
```

### 11b — Set HuggingFace fallback URLs

Find lines 361–364 and replace the `PLACEHOLDER` paths with the real HuggingFace repo and filenames:

```rust
const HF_MODEL_URL: &str =
    "https://huggingface.co/YOUR_ORG/YOUR_REPO/resolve/main/Qwen3.5-4B-Q4_K_M.gguf";
const HF_MMPROJ_URL: &str =
    "https://huggingface.co/YOUR_ORG/YOUR_REPO/resolve/main/mmproj-F16.gguf";
```

### 11c — Pin SHA-256 checksums

In the `get_llama_server_spec()`, `get_tesseract_spec()`, and `get_asset_manifest()` functions the `sha256` field is currently an empty string (`String::new()`). Fill in the hashes you recorded in Step 8.

Find each `sha256: String::new()` and replace with the actual hash, for example:

```rust
// In get_asset_manifest — mmproj entry
let mmproj = AssetManifestEntry {
    asset_id:   "mmproj_gguf".into(),
    // ...
    sha256:     "abc123def456...".into(),   // ← 64 hex chars
    // ...
};
```

Do this for every asset entry. The `verify_file_hash` command in Rust treats an empty sha256 as "skip verification", so leaving these empty means the wizard never validates downloads — a security risk for production.

---

## Step 12 — Build and test the setup wizard

```bash
cd app
npm run tauri dev
```

The app should open the setup wizard on first launch (or after clearing the `{AppData}/DataExtractionAI/` directory). Walk through all six steps and confirm:

- [ ] Hardware detection completes without errors
- [ ] All six llama-server, Tesseract, and model download tasks show correct sizes
- [ ] Progress bars advance during download
- [ ] Files land in the correct `{AppData}/DataExtractionAI/` subdirectories
- [ ] SHA-256 verification passes for all assets
- [ ] The main app launches after "Launch Artifact" is clicked

To reset the wizard during testing:

```powershell
# Windows
Remove-Item -Recurse "$env:APPDATA\com.aidenpaleczny.app" -Force
```

```bash
# macOS
rm -rf ~/Library/Application\ Support/com.aidenpaleczny.app
```

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
- [ ] `R2_BASE` constant updated in `lib.rs`
- [ ] `HF_MODEL_URL` and `HF_MMPROJ_URL` constants updated in `lib.rs`
- [ ] All `sha256` fields populated in the asset manifest
- [ ] Setup wizard tested end-to-end on at least one platform
