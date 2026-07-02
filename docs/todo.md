# To-Do

## UI / Frontend

- [ ] Add LLM chat box to the output panel so the user can ask the model to fix column structure problems automatically
- [ ] Fix: dark-mode screenshots don't render the provenance cell highlights correctly (`issues.md` → UI #1)
- [ ] Indicate in-app that extraction results are saved -- add a save-state affordance so the user can tell their work is persisted (`issues.md` → UI #2)

## Llama

- [ ] Verify the llama-server starts in a packaged (built) release -- the bundled-sidecar model was replaced by a wizard-downloaded binary launched from an explicit `llamaServerPath`, which likely fixes the original "sidecar doesn't start in built version" bug, but it hasn't been re-confirmed end-to-end on a clean packaged build (`issues.md` → Llama #2)
- [ ] Kill the llama-server immediately on a dev Ctrl-C -- a normal window close already stops it and a startup sweep reaps the orphan on next launch, so the only gap is the window between a Ctrl-C and the next start (`issues.md` → Llama #1)

## Provenance / Matching

- [ ] Fix: alignment breaks when OCR misses a word, especially when the missed word is a duplicate of a common value -- fuzzy second pass now exists, and the grid cross-check (`gridMatchPass`) re-places cells that *desynced* from a dropped word; a *missing* word itself still has no OCR run to match, so assess whether residual cases remain
- [ ] Measure Stage 2a residual rate on real documents -- count `unmatched` cells per document; this decides whether Stage 2b is worth building
- [ ] Stage 2b (LLM residual provenance) -- build only if measured residual warrants it: text-only call for unmatched cells, flat ID-per-cell output, validate range + plausibility

## OCR / Preprocessing

- [ ] Smart OCR routing: detect machine-readable PDF text layers and skip Tesseract entirely
- [ ] Multi-language OCR: allow users to drop in additional `.traineddata` files; wire language selection to the settings page

## LLM / Extraction

- [ ] Stateful multi-page context: pass column/schema information discovered on page 1 into the prompt when processing page 2+
- [ ] Agentic multi-page workflow for tables that span pages: loop OCR → LLM, detect continuations, merge across page boundaries
- [ ] User-supplied context UI: let the user inject column names, expected formats, or other instructions before extraction begins
- [ ] Unload vision model from RAM after Stage 1 completes to free resources for Stage 2 and the rest of the system

## Settings

- [ ] Hardware mode toggle: Low-End (Tesseract + lightweight LLM, no vision) vs. High-End (full vision model)

## Infrastructure / Architecture

- [ ] Background processing queue: make document processing non-blocking so the UI stays responsive during large batches -- **groundwork done:** `process_document` now runs on the blocking thread pool (`spawn_blocking`, no longer ties up the async runtime) and is cancellable mid-job via `cancel_process_document` + a `ProcessState` generation counter, with a Cancel button on the progress UI. The multi-job *queue* itself is still to build
- [ ] Hardware-adaptive model selection: detect available VRAM/RAM and choose the appropriate model size automatically
- [ ] Make background processing a paid / pro feature

## Testing

- [ ] Implement full test setup

## Roadmap

- [ ] Generative edits: prompt-to-edit workflow ("Change all dates to MM/DD/YYYY") with accept/decline diff UI
- [ ] PDF text overlay: inject a machine-readable text layer over scanned PDFs to make them searchable
- [ ] Extensible model interface: allow users to supply their own GGUF models

## Out of Scope / Later Additions

- [ ] OCR language selection (currently hardcoded to `"eng"`)


---

## Completed

### UI / Frontend

- [x] Fix: editing OCR words breaks the highlight boxes shown when clicking a cell in the output table -- provenance now stores stable `OcrWord` UUIDs (not array indices) and `getCellSourceBox` resolves them against the *current* words, so an add/edit/delete no longer shifts a cell onto the wrong box (a deleted source word yields no highlight instead). Covered by the reorder/delete cases in `provenance.test.ts`
- [x] ~~Restrict `ReactMarkdown` to a safe `allowedElements` allowlist~~ -- obsolete: `ReactMarkdown` is no longer used anywhere (LLM output renders as plain text). The `react-markdown` / `remark-gfm` deps (and the unused Rust `imageproc` crate) were removed on 2026-06-16.

### Provenance / Matching

- [x] Fix: column splitting -- multi-word column values (e.g. capitalized name + right-justified course code) are being split into separate columns -- `buildTableText` now derives column boundaries once from the header line and snaps every row to them, so a within-cell left/right gap no longer spawns a phantom unnamed column. Watch for: legitimately header-less columns now merge into their neighbour. The chat-box mitigation (let the user ask the LLM to fix structure) is still open (see UI section).
- [x] Fuzzy second pass for unmatched cells (`fuzzyMatchPass`) -- bounded Levenshtein match within the positional gap between matched neighbours; recovers single-glyph OCR misreads, flags them `fuzzy`, and lowers trust one level
- [x] Fix: empty columns ruin matching -- **mostly resolved** by the grid cross-check (`gridMatchPass`): cells the linear passes leave `unmatched` are triangulated from their matched row siblings (y-band) ∩ column neighbours (x-band). Residual: needs both a row and a column anchor, so a whole-row/column blackout still can't be placed
- [x] Investigate grid-based matching as an alternative: infer column x-ranges and row y-ranges from OCR bounding boxes to place provenance links by grid index rather than sequence position -- **done** as `gridMatchPass`, run as a cross-check *after* the sequence matcher (not a replacement)

### OCR / Preprocessing

- [x] Surface Tesseract language limitation in the UI -- the Settings → OCR → Language row now reads "English only" with the note "This version recognizes English only. Other languages are not yet supported." (`Settings.tsx`)
- [x] MIME type validation: verify magic bytes on upload, not just file extension / browser `accept` hint -- `Dashboard.tsx` keys uploads off `SUPPORTED_FILE_TYPES` and sniffs the leading bytes (`%PDF`, PNG signature, JPEG SOI) via `matchesMagic`, rejecting a mislabeled/corrupt file before any session record is created

### Settings

- [x] Implement the Settings page (currently a placeholder heading only)
- [x] Model path configuration (currently resolved at fixed paths) -- Settings → AI model exposes editable **Model path** and **Multimodal projector path** fields (browse + Save) that override the setup-installed paths on the next server start
- [x] Persisted preference storage for all settings -- `lib/settings.ts` is a typed, localStorage-backed store (`readSetting`/`writeSetting`) with per-key validators and defaults; every preference the UI exposes (theme, model path, mmproj path, llama-server path, hardware backend) persists through it across navigation and restarts

### Export

- [x] Export button and format selector in the Session page output panel
- [x] CSV export (minimum viable -- serialize the extracted table)
- [x] XLSX export -- `export_xlsx` Tauri command (`rust_xlsxwriter`) writes the workbook directly to the chosen path; header row bolded, columns autofit
- [x] HTML export
- [x] Markdown export
- [x] Plain text export
- [x] Copy table option

### First-Run Setup Wizard

- [x] Updated `docs/design.md`
- [x] Remove all bundled resources from `tauri.conf.json` (models, binaries, Tesseract)
- [x] `detect_hardware` Tauri command -- GPU name, VRAM, RAM, recommended backend (Windows/macOS; a best-effort Linux path exists but Linux is a later addition, not supported now)
- [x] `download_file` command -- async streaming with `.part` temp file, `setup:progress` events
- [x] `verify_file_hash` command -- SHA-256 integrity check
- [x] `extract_archive` command -- path-traversal-safe extraction (zip + tar.gz) via `enclosed_name()`, wrapper-folder flatten by marker binary, deletes archive after
- [x] `check_setup_complete` command -- checks 5 required AppData paths before allowing main app to load
- [x] `get_asset_manifest` command -- returns ordered asset list with primary/fallback URLs and `extract_to_dir`
- [x] `get_setup_paths` command -- resolves final binary/model paths into settings after wizard completes
- [x] Setup wizard UI: Welcome → (Config, Custom only) → Install → Complete (the original Hardware step was folded into Welcome's background probe, and Verify was folded into the single Install step)
- [x] `useSetupCheck` hook -- gates `App.tsx` on setup completion; shows wizard if incomplete
- [x] `CompleteStep` writes `llamaServerPath`, `modelPath`, `mmprojPath`, `hardwareBackend` to settings
- [x] Removed all dead bundled-resource wiring (`resolveResource`, dev path fallbacks, bundled Tesseract setup hook)
- [x] Add PDFium to the asset manifest (Windows + macOS), download into `binaries/` with archive flatten, bind via `Pdfium::bind_to_library(<explicit path>)`, gate `check_setup_complete` on it, and pin its SHA-256 (fixes `CODE_REVIEW.md` C3)
- [x] Fail closed in `verify_file_hash` on an empty/unpinned digest in release builds (debug skips with a warning) -- fixes the fail-open half of `CODE_REVIEW.md` C1
- [x] Re-run Tesseract `PATH` / `TESSDATA_PREFIX` injection at `process_document` call time so OCR works in the wizard's first session without a restart (fixes `CODE_REVIEW.md` C2)
- [x] Replace `R2_BASE` placeholder with the real asset domain (`anchor-assets.aidenpaleczny.com`)
- [x] Replace `HF_MODEL_URL` / `HF_MMPROJ_URL` placeholder constants with real HuggingFace URLs -- both point at `unsloth/Qwen3.5-4B-GGUF` resolve URLs pinned to commit `e87f176` (not `main`), so the fallback bytes can't drift from the SHA-256 pins (`setup.rs`)
- [x] Build and upload the macOS Tesseract zip to R2 and pin it (Windows pinned). _(Linux is a later addition — not needed for now.)_ -- on R2 at `macos/tesseract.zip`, SHA-256 pinned in `get_tesseract_spec`
- [x] Upload llama-server binaries per platform to R2 and pin hashes (Windows CPU/CUDA, macOS). _(Linux build deferred — later addition.)_
- [x] Upload GGUF model + mmproj files to R2 and pin their SHA-256 hashes
- [x] Pin the remaining SHA-256 hash for the supported platforms (macOS Tesseract) in `get_tesseract_spec`. _(cudart is pinned; Linux llama-server/Tesseract are intentionally left unpinned until Linux support lands.)_ -- all supported-platform hashes are now pinned
- [x] Resume interrupted downloads -- `download_file` now reconnects and resumes from the `.part` via HTTP Range
- [x] Garbage-collect abandoned `.part` files -- `sweep_stale_partials` runs at startup and deletes any `.part` older than a 7-day retention window (keeps recent ones so resume still works)
- [x] Update about page -- trimmed to shipped capabilities (removed Smart routing / Stateful multi-page / Background queue cards and the XLSX badge; fixed the stale preprocessing step and the Linux claim)
- [x] Provision the Cloudflare R2 bucket end-to-end and confirm every asset object is reachable

### Testing

- [x] Stage 2a duplicate handling: verify that N identical values each map to a distinct, correctly-positioned OCR word (not all to the first one) -- covered in `provenance.test.ts` ("disambiguates duplicate values by sequence position")
- [x] Cursor desync test: drop an OCR word and confirm a single unmatched cell does not cascade misalignment across the rest of the table -- covered in `provenance.test.ts` ("leaves a cell with no plausible source unmatched without desyncing the row")
- [x] Fuzzy second pass tests: single-glyph misread (`I`→`|`) recovers as `fuzzy`; fuzzy match cannot claim a word already owned by a matched neighbour; perfect gap hit promotes to `matched` not `fuzzy` -- covered in `provenance.test.ts`
- [x] Grid cross-check tests: a reading-order-desynced cell is recovered from its row/column anchors; no recovery when a whole column is unmatched; no word stolen below the similarity threshold -- covered in `provenance.test.ts`
- [x] Context-budget tests: token estimate (~4 chars/token), output budget clamped to remaining context, overflow flagged, never negative -- covered in `contextBudget.test.ts`
- [x] `buildTableText` header-anchored column test: a row with left- and right-justified content in one wide column stays a single column (no phantom trailing column) -- covered in `ocrTransforms.test.ts` ("keeps right-justified content in its column (no phantom trailing column)")
