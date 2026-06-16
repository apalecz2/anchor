# System Design Document — Local-First AI Data Extraction Tool

## 1. Executive Summary

This project aims to build a desktop application that acts as a "Cursor for local data extraction." It streamlines the transformation of non‑machine‑readable data (e.g., written notes, image‑based tables, flat PDFs) into structured, machine‑readable formats.

By prioritizing a local‑first architecture, the application guarantees strict data privacy for sensitive information, eliminates recurring API costs, and enables unlimited offline processing. The system relies on human verification instead of tedious manual data entry, using an intelligent split‑screen interface to highlight uncertainties and cross‑reference extracted data.

## 2. Technical Stack

| Component            | Technology                             | Rationale                                                                 |
|----------------------|----------------------------------------|---------------------------------------------------------------------------|
| Front-End            | React with TypeScript                  | Robust, type‑safe, highly interactive UI (essential for split‑screen/heatmap features).
| Framework            | Tauri                                  | Lightweight cross‑platform desktop framework with lower overhead than Electron.
| AI Model(s)          | Qwen3.5‑4b (w/ Vision)                 | Run via llama.cpp; handles vision tasks and OCR validation/cleanup locally. (A lightweight ~2B model for Low‑End Mode is planned but not yet integrated.)
| OCR Engine           | Tesseract                              | Word‑level bounding boxes and confidence scores; binarizes internally.
| Image Preprocessing  | image crate (Rust, pure)               | Pre‑OCR grayscale conversion and Lanczos upscaling; no system OpenCV dependency.

## 3. Core Features & Capabilities

### 3.1 Privacy and Cost Efficiency

- 100% local processing — no data leaves the user’s machine.
- Zero‑cost scaling — unlimited document processing without API bills.

### 3.2 Intelligent Processing & Background Queuing

- Smart routing: detect machine‑readable documents and bypass OCR when possible.
- Background queue: process large batches offline to avoid blocking the UI.
- User‑supplied context: allow users to inject instructions (expected columns, formats) before extraction.

### 3.3 Advanced Verification & UI

- Split‑screen interface: source document on the left, extracted data on the right; click any cell to highlight its exact source region in the document.
- Confidence heatmap: per‑cell trust level (high / medium / low) color‑codes the output table. Each cell's score is derived from three independent signals: LLM token log‑probabilities, Tesseract OCR word confidence, and source agreement.
- Mathematical confidence mapping: LLM geometric mean and minimum token log‑probability (from llama.cpp logprobs) are blended with Tesseract word confidence into a `cellTrust` state machine.
- Provenance by code (Stage 2a): deterministic parallel reading‑order walk links each CSV cell to its source OCR word(s). A bounded lookahead window (12 words) disambiguates duplicate values by sequence position — information the model would have to infer but code has directly. Cursor only advances on a match, so one unmatched cell cannot desync the rest of the row.
- Fuzzy second pass: cells the exact walk cannot place are re‑matched against the OCR words in the positional gap between their nearest matched neighbours, using a Levenshtein similarity threshold. This recovers single‑glyph OCR misreads (e.g. `I` read as `|`) that would otherwise leave a cell unverified; recovered cells are flagged `fuzzy` and have their trust lowered one level.
- Unmatched cell badge: cells the model read from the image with no corresponding OCR word are marked with an "unverified source" indicator rather than silently dropped. Fuzzy‑matched cells carry a separate "approximate match" (`≈`) indicator.

## 4. User Stories

| User Persona        | Story                                                                    | Goal / Value                                                          |
|---------------------|--------------------------------------------------------------------------|------------------------------------------------------------------------|
| Non‑Technical User  | "I want to attach large PDFs containing a mix of text and tables."       | Quickly receive clean CSVs for each table without manual entry.       |
| Non‑Technical User  | "I want to upload pictures of my handwritten notes."                    | Effortlessly digitize and use the text.                                |
| Any User           | "I want to click on extracted data and see exactly where it came from."  | Establish trust and simplify verification.                             |
| Any User           | "I want the app to visually flag areas it is unsure about."             | Quickly spot and fix errors without full manual proofreading.           |

## 5. System Requirements & Hardware Adaptability

- Supported platforms: **Windows and macOS**. **Linux support is a planned later addition** and is out of scope for now — no Linux assets are built, uploaded, or pinned, and the Linux code paths that exist are best-effort placeholders only.
- Minimum spec: 8 GB RAM.

Adaptive hardware modes:

- Low‑End Mode: disable vision models; rely on Tesseract + a lightweight ~2B LLM for formatting.
- High‑End Mode: enable full vision models and larger context windows when hardware permits.

- Resource management: dynamically cap/prioritize threads; keep UI thread smooth and leave headroom for OS and other apps.
- Input formats: PDF, PNG, JPEG, and common image/document formats.
- Output formats: CSV, Excel (XLSX), Markdown (MD), plain text (TXT).
- Extensible AI architecture: model‑agnostic interface to support future or user‑supplied models.

## 6. Processing Extraction Pipeline

1. Ingestion & validation
   - User uploads a file; the system validates format and checks for extractable content (filters out irrelevant photos).

2. Smart OCR
   - If non‑machine‑readable: render to a high‑resolution image (PDF path: pdfium at 2000 px wide; image upload: as-is).
   - If machine‑readable: skip OCR and proceed to AI formatting.

2a. Image preprocessing (OCR path only)
   - A grayscale (and, when small, upscaled) copy of the image is produced in a separate file for Tesseract only. The original image is unchanged and is what the vision model and UI see.
   - Pipeline (order is strict): grayscale → 2× Lanczos upscale (image-upload path only, when the narrow side < 1500 px) → save. Binarization is left to Tesseract's internal Sauvola/Otsu thresholding, which handles thin antialiased glyphs far better than a hard threshold applied at native resolution. (An earlier explicit denoise → adaptive-binarize → rule-line-removal pipeline fragmented glyphs and left smudge artifacts; see `docs/issues.md` § OCR/Preprocessing for the post-mortem.)
   - Tesseract runs with `psm 6` (single uniform block — best for tabular layouts) and no forced DPI, letting it estimate from the image.
   - **Coordinate alignment:** upscaling is the only geometric transform. When applied, every Tesseract bounding box returned after OCR is divided by the scale factor before being stored, so all box coordinates remain in the original image's coordinate space. PDF inputs are already high-res (2000 px); they are never upscaled, so their scale factor is always 1.0.
   - Stray `|` glyphs that Tesseract reads from table rule lines are stripped later, during context assembly (step 3), rather than removed from the image.

3. Context assembly
   - Sanitize OCR words once: strip column-rule pipe glyphs, filter empties, assign stable integer IDs. This single array feeds both downstream formatters.
   - Two formatters from the same array: (a) **spatial text** — words placed at character columns proportional to pixel X position, preserving column alignment for the vision model; (b) **indexed word list** — each word with ID, text, bounding box, and confidence — used by Stage 2a matching.
   - Spatial text column model: column boundaries are derived once from the header (first) line and every row is snapped to those columns; intra‑column words are joined with a single space. Because real columns are vertically consistent across rows while a wide cell holding left‑ and right‑justified content is not, pinning every row to the header's columns prevents that within‑cell gap from reading as a column break and spawning a phantom, unnamed trailing column.

4. Stage 1 — Structured extraction (LLM, vision)
   - The vision-language model receives the document image and spatially-arranged OCR text. Settings: temperature 0, top‑k 1, no presence penalty, no grammar constraint. Output: clean TSV with the first row as the header.
   - TSV is used instead of CSV because tab characters cannot appear in OCR output and are not found in table cell content, so no escaping or quoting is needed. This avoids ambiguity when cell values contain commas (e.g. course descriptions, numeric formatting).
   - Token log‑probabilities are collected with cumulative character offsets during streaming for downstream confidence scoring.

4a. Stage 2a — Provenance by code (deterministic)
   - Parallel reading-order walk: iterate TSV cells and OCR words simultaneously in the same left-to-right, top-to-bottom order.
   - `matchFromCursor`: bounded lookahead of 12 words from the current cursor position. Handles single-word and multi-word cell values. Cursor advances only on a match — one unmatched cell cannot desync the rest of the table.
   - Fuzzy second pass (`fuzzyMatchPass`): after the exact walk, each still-`unmatched` cell is searched against the OCR words bounded by its nearest matched neighbours (lower bound = max word ID of the previous match + 1; upper bound = min word ID of the next match). The best contiguous run by normalized Levenshtein similarity wins if it clears a 0.8 threshold. Bounding to the gap keeps reading order intact and prevents stealing a word another cell already claimed. A perfect (1.0) hit is promoted to a normal `matched`/`multi_word`; anything below is flagged `fuzzy`.
   - Produces `CellProvenance` per cell: `matched` | `multi_word` | `fuzzy` | `unmatched`.

5. Confidence scoring
   - LLM confidence: geometric mean and minimum of per-token probabilities for each cell, mapped from Stage 1 logprob offsets to cell character ranges.
   - OCR confidence: mean Tesseract word confidence of matched words; `null` for unmatched cells.
   - Agreement: `agree` (code-matched, including fuzzy), `image_only` (no OCR source), `disagree` (Stage 2b mismatch, future).
   - `cellTrust` state machine: `high` → green / `medium` → yellow / `low` → red. Drives the per-cell UI heatmap. Fuzzy-matched cells have their computed trust knocked down one level to reflect the approximate OCR agreement.

6. Memory unloading
   - Unload the AI model from RAM after Stage 1 completes to free resources (unless queued jobs remain). The vision projector is not needed for Stage 2.

7. Human verification
   - Provenance table with per-cell trust coloring. Click any cell to highlight its bounding box on the source document. Unmatched cells show an "unverified source" (`?`) badge; fuzzy-matched cells show an "approximate match" (`≈`) badge.

8. Export
   - Save the verified output in the user’s chosen format.

## 7. Post‑Install Dependency Setup

The app installer is intentionally small (< 20 MB). Platform‑specific binaries and large AI models are downloaded inside the app on first launch and stored in the user's AppData directory. Subsequent launches skip the wizard if all assets are detected.

### 7.1 Asset Inventory

Platforms below are limited to the currently supported targets (**Windows + macOS**); "All" means all *supported* platforms. **Linux is a later addition** — its assets are intentionally not built or pinned yet.

| Asset | Platforms | Primary Source | Fallback | Size |
|---|---|---|---|---|
| Tesseract (zip, incl. tessdata) | Windows | Cloudflare R2 | — | ~38 MB |
| Tesseract (zip, incl. tessdata) | macOS | Cloudflare R2 | — | ~5.7 MB |
| `llama-server` CPU build | Windows | Cloudflare R2 | llama.cpp GitHub releases | ~17 MB |
| `llama-server` CUDA build | Windows | Cloudflare R2 | llama.cpp GitHub releases | ~261 MB |
| CUDA runtime libraries (`cudart`) | Windows (CUDA only) | Cloudflare R2 | — | ~391 MB |
| `llama-server` Metal build | macOS (Apple Silicon) | Cloudflare R2 | llama.cpp GitHub releases | ~10.5 MB |
| PDFium shared library | Windows / macOS | Cloudflare R2 | — | ~3.7 MB |
| `Qwen3.5‑4B‑Q4_K_M.gguf` | All | Cloudflare R2 | HuggingFace (Qwen/Qwen3‑4B‑GGUF) | ~2.74 GB |
| `mmproj‑F16.gguf` | All | Cloudflare R2 | HuggingFace (compatible clip projector) | ~672 MB |

Sizes above are the actual R2 object `Content-Length` values (verified 2026-06-16) and match `size_bytes` in the asset manifest, which seeds the progress bar and time-remaining estimate. The bundled `eng.traineddata` ships inside the Tesseract zip rather than as a separate object.

Cloudflare R2 is the primary source for all assets because it offers zero egress fees and consistent global latency. For the two GGUF model files, HuggingFace is available as a fallback if the R2 bucket is unreachable (the wizard retries a failed download once from the fallback URL).

PDFium is required because `pdfium-render` binds to a pdfium shared library at runtime, and neither Windows nor macOS ships one. The wizard downloads the upstream prebuilt archive (the library nests under `bin/` on Windows and `lib/` on macOS; extraction flattens it directly into `binaries/`) and the backend binds to that explicit path.

All asset URLs, expected SHA‑256 digests, and destination paths are hardcoded as constants in the Rust backend so they can be audited and updated as a unit when new model or binary versions are pinned.

Note: Still outstanding for the supported platforms: the HuggingFace fallback URLs are placeholders, and the macOS Tesseract build is not yet pinned/uploaded. On a hash mismatch the wizard now automatically discards the partial download and retries from the fallback URL where one exists (the two GGUF models); an asset with no fallback (the binaries) surfaces an error and asks the user to re‑run setup. **Linux assets (the Linux llama-server build and Linux Tesseract) are deliberately not pinned or uploaded — Linux is a later addition and not required for now.**

### 7.2 Storage Layout

Everything is stored under the Tauri AppData directory, which is derived from the app identifier `com.aidenpaleczny.artifact` (`%APPDATA%\com.aidenpaleczny.artifact` on Windows, `~/Library/Application Support/com.aidenpaleczny.artifact` on macOS). The identifier deliberately does not end in `.app`: macOS Finder treats any directory whose name ends in `.app` as an application bundle/package, which made the data directory display as an opaque package rather than a folder.

```
{AppData}/com.aidenpaleczny.artifact/
  binaries/
    llama-server[.exe]
    pdfium.dll / libpdfium.dylib    (Windows / macOS only)
  tesseract/
    tesseract[.exe]
    *.dll                    (Windows only)
    tessdata/
      eng.traineddata
  models/
    Qwen3.5-4B-Q4_K_M.gguf
    mmproj-F16.gguf
```

The Rust startup hook that injects Tesseract into `PATH` and `TESSDATA_PREFIX` reads from this AppData directory rather than the bundle's resource folder. The llama‑server path stored in settings points here too.

### 7.3 Hardware Detection

Before presenting download options the app queries the host GPU to select the correct llama‑server build:

- **Windows** — WMI (`Win32_VideoController`), with `nvidia-smi` for accurate VRAM on NVIDIA cards.
- **macOS** — `system_profiler SPDisplaysDataType`.

(A best-effort `lspci`/`nvidia-smi` Linux path exists in the code but is unsupported and untested — see the Linux note in §5.)

Detection output drives a `recommended_backend` value: `cuda` (NVIDIA, ≥ 4 GB VRAM), `metal` (Apple Silicon), or `cpu` (fallback). The user can override the recommendation before downloading. (`rocm` for AMD is reserved for the future Linux target and is not offered on the supported platforms.)

### 7.4 First‑Run Wizard Flow

The wizard runs inside the existing app window; no separate Tauri window is created. It renders in place of the normal app routes until setup completes, then reloads.

```
Welcome → (Configuration) → Install → Complete
```

- **Welcome** — lists what will be downloaded and the estimated total size, and probes hardware in the background. Offers a one‑click *Automatic* path (uses the recommended backend) or a *Custom* path (opens Configuration).
- **Configuration** *(Custom only)* — backend selector (CPU / CUDA / ROCm / Metal), defaulting to the recommended value and filtered to the platform's available builds. (A Tesseract language‑data tier selector — fast / standard / best — is planned but not yet implemented; the wizard currently downloads a single English tier.)
- **Install** — a single step that downloads, verifies, and unpacks every asset. The focal point is one prominent **overall progress bar** (byte‑weighted, so the multi‑GB model dominates and the bar moves smoothly) with a **total time‑remaining estimate** beside it. The estimate is computed live from smoothed download throughput (a 1 s ticker over a trailing window) against the bytes still to go, and is phrased plainly for non‑technical users ("About 8 minutes remaining"). The per‑component list is tucked behind a **"Show details" disclosure, collapsed by default**, to keep the screen minimal; expanded, each component shows its own progress and — for the asset currently downloading — its own time remaining under the `x MB / y MB` readout. Key properties:
  - **Streaming verification:** the SHA‑256 is computed *incrementally from the bytes as they download* (`download_file`), so there is no separate read‑the‑whole‑file‑again verify pass. The `.part` temp file is renamed to its final path **only after** the hash matches — a corrupt/truncated download never leaves a "complete‑looking" file behind. On a mismatch the wizard discards the partial bytes and retries from the fallback URL.
  - **Sequential downloads, overlapped extraction:** downloads run one at a time (they share a single network pipe, so racing them wouldn't be faster), but an archive's extraction (`extract_archive`, run off‑thread via `spawn_blocking`) is kicked off without blocking the *next* asset's download — CPU/disk work overlaps network work.
  - **Resilience:** dropped or stalled connections reconnect and resume from the `.part` via HTTP Range; progress events are coalesced to ~10/sec.
  - **Cancellable / resumable:** the user can cancel at any time (a Cancel button, or by closing the window — which prompts a confirmation rather than silently discarding work). Cancelling advances a monotonic generation counter that the in-flight download polls between chunks, so even the multi-GB model stops promptly; the partially-downloaded `.part` and any already-installed assets are kept, so the next run skips finished assets and resumes the rest. Because nothing reaches its final path until verified, an interrupted install can never leave a corrupt file behind.
- **Complete** — writes all resolved paths (`modelPath`, `mmprojPath`, `llamaServerPath`) and the chosen `hardwareBackend` to persistent settings, then reloads the webview to enter the main app.

### 7.5 Settings Schema Additions

Two new keys are added alongside the existing settings:

| Key | Type | Purpose |
|---|---|---|
| `llamaServerPath` | `string` | Absolute path to the downloaded llama‑server binary |
| `hardwareBackend` | `'cpu' \| 'cuda' \| 'rocm' \| 'metal'` | Chosen acceleration backend; controls which llama‑server build is used |

The existing `modelPath` and `mmprojPath` keys, previously empty strings by default, are populated by the wizard with their AppData locations.

---

## 8. Future Roadmap & Optional Features

- Generative edits: prompt‑to‑edit workflow (e.g., "Change all dates to MM/DD/YYYY") with accept/decline diffs.
- Mobile companion app: scan on the go and sync to the desktop queue.
- PDF text overlay: inject an invisible machine‑readable text layer over scanned PDFs to make them searchable.

