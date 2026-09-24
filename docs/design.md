# System Design Document — Local-First AI Data Extraction Tool

## 1. Executive Summary

This project aims to build a desktop application that acts as a "Cursor for local data extraction." It streamlines the transformation of non‑machine‑readable data (e.g., written notes, image‑based tables, flat PDFs) into structured, machine‑readable formats.

By prioritizing a local‑first architecture, the application guarantees strict data privacy for sensitive information, eliminates recurring API costs, and enables unlimited offline processing. The system relies on human verification instead of tedious manual data entry, using an intelligent split‑screen interface to highlight uncertainties and cross‑reference extracted data.

## 2. Technical Stack

| Component            | Technology                             | Rationale                                                                 |
|----------------------|----------------------------------------|---------------------------------------------------------------------------|
| Front-End            | React with TypeScript                  | Robust, type‑safe, highly interactive UI (essential for split‑screen/heatmap features).
| Framework            | Tauri                                  | Lightweight cross‑platform desktop framework with lower overhead than Electron.
| AI Model(s)          | Qwen3.5‑4b (w/ Vision)                 | Run via llama.cpp; handles vision tasks and OCR validation/cleanup locally.
| Pipeline description | Typed Rust catalog (`pipeline/catalog.rs`) | Which models exist, what each is allowed to do, and the ordered *presets* that combine them. Data, not hardcoded call sites — but **compiled** data, so model URLs, digests, launch flags and prompts stay auditable as a unit (§7.1).
| Pipeline execution   | `pipeline/executor.rs` (Rust)          | Walks a preset's steps for one page: residency, streaming, cancellation. Provenance and confidence stay in TypeScript, where they are pure and heavily tested.
| OCR Engine           | Tesseract, or **oar-ocr** (`catalog::OcrEngine`) | Which engine grounds a page is a property of the active *preset*, not a fixed choice. Tesseract: word‑level bounding boxes and confidence scores from `image_to_data`; binarizes internally. oar-ocr: a pure-Rust, ONNX-Runtime-based engine (PP‑OCRv6 models) with no Tesseract/Python dependency and real per-word *boxes*, but only line-level confidence (§6 step 5). Debug builds only for now — see §5.
| Image Preprocessing  | image crate (Rust, pure)               | Pre‑OCR grayscale conversion and Lanczos upscaling; no system OpenCV dependency.

## 3. Core Features & Capabilities

### 3.1 Privacy and Cost Efficiency

- 100% local processing — no data leaves the user’s machine.
- Zero‑cost scaling — unlimited document processing without API bills.

### 3.2 Intelligent Processing & Background Queuing

- Smart routing: detect machine‑readable documents and bypass OCR when possible.
- Background queue: process large batches offline to avoid blocking the UI.
- Responsive, cancellable processing: document render/OCR runs on a background (blocking) thread rather than the UI/async runtime, and a long job (e.g. a 100‑page PDF) can be cancelled mid‑run — the worker checks a cancellation flag between pages and stops within one page. This is the foundation the background queue builds on.
- User‑supplied context: allow users to inject instructions (expected columns, formats) before extraction.

### 3.3 Advanced Verification & UI

- Split‑screen interface: source document on the left, extracted data on the right; click any cell to highlight its exact source region in the document.
- Confidence heatmap: per‑cell trust level (high / medium / low) color‑codes the output table. Each cell's score is derived from three independent signals: LLM token log‑probabilities, Tesseract OCR word confidence, and source agreement.
- Mathematical confidence mapping: LLM geometric mean and minimum token log‑probability (from llama.cpp logprobs) are blended with the grounding source's word confidence into a `cellTrust` state machine. The agreement axis is “structure source vs grounding source” rather than “LLM vs Tesseract”, so a pipeline whose grounding comes from a model is scored the same way; a pipeline with *no* grounding step is marked `self_reported` and capped at medium, because the green that means “two independent sources agree” is not available to it (§6 step 5).
- Provenance by code (Stage 2a): a deterministic grid‑first matcher links each TSV cell to its source OCR word(s). Column bands are detected from the word geometry as whitespace channels — x‑intervals crossed by few or no word boxes over the table's full height — which makes them justification‑agnostic (left‑, right‑ and centre‑justified cell content all resolve to the same band). TSV rows are aligned to visual lines by content (a dynamic‑programming alignment that lets one row span several wrapped lines, skips noise lines like titles, and leaves an OCR‑dropped row unassigned), and each cell then matches only against the unclaimed words inside its own row × column region. Duplicate values disambiguate by grid position rather than sequence, and wrapped multi‑line cells — whose words interleave with other columns' words in reading order — match naturally. When no grid is detectable (single‑column output, non‑tabular layout) or the detected grid places under 30% of non‑empty cells, a bounded reading‑order walk (12‑word lookahead; the cursor only advances on a match, so one unmatched cell cannot desync the rest) takes over as the primary pass. A pipeline whose grounding model reports the bands directly skips the detection entirely and matches within the **declared** grid — replacing the most failure‑prone inference in the app with ground truth (§6 step 3a).
- Fuzzy second pass: cells the primary pass cannot place are re‑matched against the OCR words in the positional gap between their nearest matched neighbours, using a Levenshtein similarity threshold. This recovers single‑glyph OCR misreads (e.g. `I` read as `|`) that would otherwise leave a cell unverified; recovered cells are flagged `fuzzy` and have their trust lowered one level.
- Grid cross‑check (third pass): cells the earlier passes still cannot place — typically because a column was reordered relative to reading order, or the column geometry was too messy for channel detection — are triangulated spatially. The cell's row band is taken from the OCR words its already‑matched row siblings occupy, and its column band from the words that column occupies in other rows; only unclaimed OCR words whose centre falls inside both bands are considered. Requiring both a row and a column anchor keeps the pass conservative, so it never steals a confidently‑placed word.
- Unmatched cell badge: cells the model read from the image with no corresponding OCR word are marked with an "unverified source" indicator rather than silently dropped. Fuzzy‑matched cells carry a separate "approximate match" (`≈`) indicator.
- Table editing: the output table is directly editable, so a structural mistake by the model is fixed in place instead of after export. Range selection (drag, Shift+click/arrow, row/column handles, Ctrl+A) drives bulk actions — mark checked, clear, copy/cut/paste as TSV — and the structural commands cover insert/delete/move for rows and columns, joining cells or whole columns, and delete/insert‑cells with a left/right shift to re‑align a row the OCR shifted. Every command is undoable. See §6 step 7.
- Empty‑cell handling: a blank TSV cell is a distinct `empty` status, not a failed match — it renders neutrally (no trust tint, no badge), so sparse tables don't read as walls of warnings. Emptiness is *verified* spatially: after all matching passes, any OCR text left unclaimed inside an empty cell's row × column region means the model may have silently dropped content — the worst failure mode for a data‑extraction tool. Such cells are flagged as a disagreement (red, `!` badge) and carry the overlooked words' ids, so clicking the cell highlights exactly the text that was skipped. An all‑empty TSV column is also excluded from column‑band detection (it has no ink, so demanding a whitespace channel for it would break the grid for the whole table).

## 4. User Stories

| User Persona        | Story                                                                    | Goal / Value                                                          |
|---------------------|--------------------------------------------------------------------------|------------------------------------------------------------------------|
| Non‑Technical User  | "I want to attach large PDFs containing a mix of text and tables."       | Quickly receive clean CSVs for each table without manual entry.       |
| Non‑Technical User  | "I want to upload pictures of my handwritten notes."                    | Effortlessly digitize and use the text.                                |
| Any User           | "I want to click on extracted data and see exactly where it came from."  | Establish trust and simplify verification.                             |
| Any User           | "I want the app to visually flag areas it is unsure about."             | Quickly spot and fix errors without full manual proofreading.           |

## 5. System Requirements & Hardware Adaptability

- Supported platforms: **Windows 10 (22H2+) / 11 (x86_64)** and **macOS on Apple Silicon**. Intel Macs are not supported — the `.app` bundle is built as a universal binary (§7.1's `universal-apple-darwin` target lets it install and launch on Intel), but the `llama-server` and PDFium binaries the first-run wizard downloads are arm64-only, so the setup wizard cannot complete on Intel hardware. **Linux support is a planned later addition** and is out of scope for now — no Linux assets are built, uploaded, or pinned, and the Linux code paths that exist are best-effort placeholders only.
- Minimum spec: 8 GB RAM.

**Adaptive hardware modes are expressed as pipeline presets**, not as a mode flag. Each preset in the catalog declares what it needs (`requires.min_ram_mb`, `min_vram_mb`); `hardware::recommend_preset` picks the first preset in catalog order the machine satisfies, and the wizard installs only that preset's assets. `PRESETS` is ordered most‑capable‑first, and that ordering *is* the ranking — there is no separate rank field that could disagree with the steps.

**Release builds ship exactly one preset today** — `catalog::PRESETS` is itself split by `#[cfg(debug_assertions)]`, not just `DEFAULT_PRESET_ID`, so the presets below the line are invisible to `hardware::recommend_preset` and to the Settings picker outside a debug build:

| Tier | Preset (id) | What it runs | Ships in release? |
|---|---|---|---|
| 8 GB | `tesseract-qwen3.5-4b` (**Fast**, default) | Tesseract grounds the page, Qwen3.5 4B builds the table. Today's shipped behaviour. | Yes |
| 8 GB | `oar-ocr-qwen3.5-4b` (**Fast (Rust OCR)**) | **oar-ocr** (pure-Rust, ONNX Runtime, PP‑OCRv6) grounds the page instead of Tesseract; Qwen3.5 4B builds the table. Debug builds default to this preset (`DEFAULT_PRESET_ID`) — tested more accurate than Tesseract, but stays debug-only until its ModelScope-fetched model files are mirrored and pinned through `setup.rs`'s manifest the way every other asset is (§7.1's pinning invariant). | Debug only |
| 16 GB | `tesseract-surya-qwen3.5-4b` (**Accurate**) | Tesseract's words, Surya's row/column grid, Qwen3.5 4B's table. | Debug only |
| 16 GB | `oar-ocr-surya-qwen3.5-4b` (**Accurate (Rust OCR)**) | `tesseract-surya-qwen3.5-4b` with oar-ocr standing in for Tesseract — same word‑grounder‑plus‑grid pairing, same reasoning. | Debug only |
| 16 GB | `oar-ocr-surya-no-llm` (**Rust OCR + Surya (no LLM)**) | oar-ocr's words and Surya's grid, intersected directly into a table by `Step::AssembleFromGrid` (§6) — **no LLM call at all**. Fastest option; quality depends entirely on OCR + grid accuracy, with no second pass to catch either one being wrong. | Debug only |

The four gated presets are **built but not yet offered** in release, for two independent reasons that happen to gate the same set: the two Surya-grounded presets name a model whose downloads are not pinned (a model the catalog offers while the installer cannot verify it is exactly what §7.1's pinning invariant exists to prevent), and the two oar-ocr-grounded presets rely on `auto-download` fetching live from ModelScope rather than Anchor's own pinned manifest — the same Microsoft Store 10.2.2 concern, different asset. Each is defined and validated by tests in the meantime so it cannot rot while it waits; a preset joins `PRESETS` in the same change that adds its assets' real SHA-256 pins to `setup.rs`. (A sixth preset, `custom-gguf`, is intentionally never in `PRESETS` at all — see §7.5.)

Unreadable VRAM disqualifies a machine from a VRAM‑gated preset — deliberately the opposite of how `recommend_backend` treats the same unknown. Guessing wrong about the backend costs some speed; guessing wrong here costs a multi‑gigabyte download for a pipeline that then cannot run.

- Resource management: dynamically cap/prioritize threads; keep UI thread smooth and leave headroom for OS and other apps.
- Input formats: PDF, PNG, JPEG, and common image/document formats.
- Output formats: CSV, Excel (XLSX), Markdown (MD), plain text (TXT).
- Extensible AI architecture: a model‑agnostic pipeline whose steps, models and prompts are catalog data (§6), plus a user‑supplied GGUF slot (§7.5).

## 6. Processing Extraction Pipeline

**The pipeline is data.** A *preset* is an ordered list of typed `Step`s — `Render`, `GroundOcr` (classical OCR: Tesseract or oar-ocr), `GroundModel` (ground on a model's own output directly; declared in the type system, not yet implemented — `executor.rs` returns a clear error rather than pretending to run it), `GroundGrid` (a model reports row/column bands), `Structure` (an LLM builds the table), `Verify`, and `AssembleFromGrid` (build the table directly from grid ∩ OCR words, **no model call** — see step 3a) — naming models from a catalog of what each model is allowed to do. `pipeline/executor.rs::run_page` walks those steps for one page and returns a `PageArtifact`; nothing below is a hardcoded call site. The numbered stages that follow describe the **default shipped preset** (`tesseract-qwen3.5-4b`), which reproduces the behaviour the app has always had; where another preset differs — including the debug-only presets in §5 that swap in oar-ocr or skip the LLM entirely — it is called out.

Three rules govern the shape of this:

- **The catalog is compiled Rust constants, not a file the user can edit.** A step may only name a model whose declared `roles` include the role that step needs, and a model that reports no locations may not ground a page; `validate_catalog` enforces both, and a unit test runs it over the whole catalog. Making the manifest editable would let arbitrary flags reach the `llama-server` argv and would break the pinning claim in §7.1.
- **The Rust↔TypeScript seam sits just before scoring.** The executor owns model I/O, residency and cancellation; provenance (step 4a) and confidence (step 5) stay pure TypeScript. The artifact therefore carries the *inputs* those stages need — the sanitized words the model was actually shown, any grid a model reported, the raw output, and per‑token logprobs — rather than re‑derived equivalents. Deriving the word list twice is how provenance silently matches against something the model never saw.
- **Character offsets crossing the seam are UTF‑16 code units**, matching JavaScript's `String.length`. Rust's native byte offsets agree only for ASCII; one accented character would misalign every logprob after it, and nothing would report an error.

1. Ingestion & validation
   - User uploads a file; the system validates format and checks for extractable content (filters out irrelevant photos).

2. Smart OCR
   - If non‑machine‑readable: render to a high‑resolution image (PDF path: pdfium at 2000 px wide; image upload: as-is).
   - If machine‑readable: skip OCR and proceed to AI formatting.

2a. Image preprocessing (OCR path only)
   - A grayscale (and, when small, upscaled) copy of the image is produced in a separate file for the OCR pass only — shared by whichever engine the active preset's `GroundOcr` step names (`catalog::OcrEngine::Tesseract` or `::OarOcr`), run before that dispatch (`ocr.rs::preprocess_for_ocr`, called once, ahead of the `match engine`). The original image is unchanged and is what the vision model and UI see.
   - Pipeline (order is strict): grayscale → 2× Lanczos upscale (image-upload path only, when the narrow side < 1500 px) → save. Binarization is left to the OCR engine's own internal thresholding (Tesseract's Sauvola/Otsu; oar-ocr's PP‑OCRv6 detector has its own), which handles thin antialiased glyphs far better than a hard threshold applied at native resolution. (An earlier explicit denoise → adaptive-binarize → rule-line-removal pipeline fragmented glyphs and left smudge artifacts; see `docs/issues.md` § OCR/Preprocessing for the post-mortem.)
   - **Tesseract** runs with `psm 6` (single uniform block — best for tabular layouts) and no forced DPI, letting it estimate from the image. **oar-ocr** (`ocr.rs::run_oar_ocr`) instead runs a two-stage ONNX detector + recognizer named by the preset's `OarOcrSpec` (`det_model`/`rec_model`/`dict`, today PP‑OCRv6 "small") via the `ort` crate — a pure-Rust path with no Tesseract dependency at all. Both engines return the same `OcrWord` shape (`text`, `confidence`, `box_coords`), which is what lets everything downstream of this step be engine-agnostic; the one place the two are *not* equivalent is confidence (see step 5).
   - **Coordinate alignment:** upscaling is the only geometric transform. When applied, every returned bounding box (from either engine) is divided by the scale factor before being stored, so all box coordinates remain in the original image's coordinate space. PDF inputs are already high-res (2000 px); they are never upscaled, so their scale factor is always 1.0.
   - Stray `|` glyphs that Tesseract reads from table rule lines are stripped later, during context assembly (step 3), rather than removed from the image.

3. Context assembly *(the preset's grounding step)*
   - Sanitize OCR words once: strip column-rule pipe glyphs, filter empties, keep each word's stable UUID. This single array feeds both downstream formatters **and is returned in the artifact**, so Stage 2a matches against exactly the list the model saw.
   - Two formatters from the same array: (a) **spatial text** — words placed at character columns proportional to pixel X position, preserving column alignment for the vision model; (b) **indexed word list** — each word with ID, text, bounding box, and confidence — used by Stage 2a matching.
   - Spatial text column model: column boundaries are derived once from the most representative line and every row is snapped to those columns; intra‑column words are joined with a single space. Because real columns are vertically consistent across rows while a wide cell holding left‑ and right‑justified content is not, pinning every row to one line's columns prevents that within‑cell gap from reading as a column break and spawning a phantom, unnamed trailing column.
   - This runs in Rust (`pipeline/prompt.rs`), ported from the original TypeScript. The two must agree byte for byte, which a **golden‑file equivalence test** enforces: a shared fixture runs through both languages and the outputs are compared. The fixture deliberately contains a non‑ASCII cell, because UTF‑16 versus UTF‑8 length is the trap that would otherwise shift every column silently.

3a. Grid mapping *(optional; the debug-only Accurate-tier presets — see §5 for their status)*
   - A grounding model is asked for the table's **row and column bands** — geometry only, no text — and returns them normalized 0–1000 per axis. `pipeline/surya.rs` parses them and converts to page pixels **at the seam**, so exactly one coordinate space reaches provenance, confidence and the overlay.
   - This is a separate axis from grounding, not a better grounding tier, and the distinction is what the spike in `prototypes/Surya` established: Surya's band geometry was exact (13 × 6 bands, a perfect column tiling) while its own table markup contradicted it — collapsing two columns under one header and dropping a value. The classical OCR engine (Tesseract or oar-ocr) is the reverse: good at reading words, poor at inferring where the columns are. So every Accurate-tier preset takes **the classical engine's words with the model's grid**, and box precision stays at word level (finer than cell, not coarser).
   - An unusable answer costs the page the grid and nothing else. The parser is tolerant (code fences, wrapper objects, prose around the array, a truncated response) and returns *no* grid rather than a bad one, falling back to the inference in step 4a.
   - **`Step::AssembleFromGrid` — building the table without a structuring model at all.** `oar-ocr-surya-no-llm` (§5) replaces step 4 (Structure) with a direct intersection: each cell is the OCR words whose box centre falls in that row×column region, joined left to right (`executor.rs::assemble_table_from_grid`; validated standalone in `prototypes/OarOcrSurya`). This only exists downstream of a *declared* grid — a preset with no `GroundGrid` step has nothing to intersect against and cannot use it. Provenance and confidence need no special case for it: the synthesized TSV is built from the same words the grid-first matcher (step 4a) would match it back to, so it round-trips through the normal scoring path as if an LLM had produced identical output.

4. Stage 1 — Structured extraction (LLM, vision)
   - The vision-language model receives the document image and spatially-arranged OCR text. Every sampling parameter comes from the model's catalog entry (`RequestSpec`) rather than from the call site — for Qwen: temperature 0, top‑k 1, no presence penalty, no grammar constraint. Output: clean TSV with the first row as the header.
   - The page image is attached **only to a model whose catalog entry says it can read one**, and the context budget charges image tokens on the same condition. A text‑only model gets a prompt variant that does not mention an attached image, because telling a model to consult an image that is not there is worse than not mentioning one.
   - Streaming reaches the UI as **deltas**, coalesced to ~10/sec — not as the accumulated string, which is quadratic in bytes over the IPC bridge. Cancellation races the read with `tokio::select!` rather than being polled between chunks, so a 30–120 s step aborts mid‑token instead of at the next page boundary.
   - TSV is used instead of CSV because tab characters cannot appear in OCR output and are not found in table cell content, so no escaping or quoting is needed. This avoids ambiguity when cell values contain commas (e.g. course descriptions, numeric formatting).
   - Token log‑probabilities are collected with cumulative character offsets during streaming for downstream confidence scoring.
   - Context budget: the prompt's estimated token footprint (image + spatial OCR text) is checked against the model's context window. The output token budget is clamped to the room the prompt actually leaves — never requesting more output than can fit — and a page too dense to plausibly fit in one pass is flagged to the user (`contextOverflow`) instead of silently truncating. If the model still hits its output limit, the truncation is surfaced with a Retry that re‑runs against the full remaining context window (more memory/time, opt‑in).

4a. Stage 2a — Provenance by code (deterministic)
   - **Where the grid comes from is the one thing grounding changes** (`resolveGrid`). A grid *declared* by a model is used whenever the run supplied one; otherwise it is inferred from word geometry as described below. Keying this on the grid's presence rather than on the grounding tier is deliberate — the two are separate axes, and conflating them would rule out the words‑plus‑declared‑grid pairing the Accurate preset uses. A declared grid that turns out not to describe this TSV (its column count disagrees, or its bands contain none of the words) falls back to *inference*, not to the reading‑order walk: two descriptions of the page disagreeing is not evidence that the page has no columns. Region‑level (`block`) and ungrounded (`none`) runs infer nothing at all — there are no whitespace channels between region boxes, so inferring from them would be reading structure out of noise.
   - Grid-first spatial matching (primary, `detectTableGrid` + `gridMatchCells`): the table's geometry, not reading order, drives the match.
     - Column detection (`detectColumnSeparators`): a sweep over word-box x-intervals finds whitespace channels — maximal x-ranges crossed by at most *k* boxes over the table's full height. *k* escalates from 0 (up to ~20% of the line count) so one full-width line (a title, or an OCR word merged across a rule) cannot erase a real column gap. The TSV's own column count (mode of row lengths) says how many separators to pick — counting **content-bearing columns only**: an all-empty TSV column has no ink in the image (its band and both flanking gaps merge into one channel), so demanding a separator for it would fail detection; empty columns keep their TSV index but map to no band. The widest channels win, which discards narrow accidental channels from vertically-aligned intra-cell spaces. A word belongs to the column band containing its horizontal centre, so justification (left/right/centre) is irrelevant.
     - Row alignment (`alignRowsToLines`): TSV rows are aligned to visual lines with a Needleman–Wunsch-style DP — a row may consume 1–5 consecutive lines (wrapped cells), a line may be skipped (noise the model excluded), and a row may consume none (OCR dropped it, small penalty). Span similarity is computed per column — words bucketed by band and concatenated across the span — which un-interleaves wrapped content; a row must clear a minimum similarity (0.3) to claim lines, so a missing row stays missing instead of stealing a near-duplicate neighbour.
     - Per-cell matching: each cell considers only unclaimed words inside its own row × column region; the best contiguous run by normalized Levenshtein similarity wins if it clears the 0.8 threshold (perfect → `matched`/`multi_word`, else `fuzzy`). Duplicates disambiguate by grid position; empty cells simply have no candidates.
     - Acceptance gate: if no grid is detectable (fewer than 2 columns, no channels) or the grid places under 30% of non-empty cells (the model restructured columns relative to the page), the grid result is discarded.
   - Reading-order walk (fallback primary): iterate TSV cells and OCR words in parallel left-to-right, top-to-bottom order. `matchFromCursor`: bounded lookahead of 12 words; the cursor advances only on a match — one unmatched cell cannot desync the rest of the table.
   - Fuzzy second pass (`fuzzyMatchPass`): each still-`unmatched` cell is searched against the unclaimed OCR words bounded by its nearest matched neighbours (lower bound = max word index of the previous match + 1; upper bound = min word index of the next match). The best contiguous run by normalized Levenshtein similarity wins if it clears the 0.8 threshold. Bounding to the gap keeps reading order intact; after the grid pass matched indices are no longer monotonic, so an inverted gap simply yields no candidates.
   - Grid cross-check (`gridMatchPass`): a pass for cells still left `unmatched` — reordered columns, or column geometry too messy for channel detection. The cell's row band is the y-range of the OCR words its already-matched row siblings occupy; its column band is the x-range that column occupies in other matched rows. Only unclaimed OCR words whose box centre lies inside both bands are candidates, judged by the same 0.8 threshold. Requiring both a row and a column anchor makes the pass fire only when the surrounding grid is solid enough to locate the gap unambiguously.
   - Emptiness verification (`verifyEmptyCellsPass`, final pass): a blank TSV cell is the claim "the source is blank here", which no matching pass can check. This pass locates the cell's region from anchors — row band from matched row siblings; column band from the column's matched words in other rows, or, for an all-empty column, the gap between the nearest anchored columns on both sides — and collects the unclaimed OCR words centred inside it. If their normalized text totals ≥ 2 characters (a lone rule-line glyph or speck is not evidence), the cell keeps status `empty` but carries those words' ids as *overlooked* text: the model may have dropped content, and clicking the cell highlights exactly what was skipped. Cells whose region cannot be located stay unflagged (unverifiable, not suspicious); claimed words are never counted.
   - All passes share one claimed-word set, so no pass can steal a word another cell already owns. Produces `CellProvenance` per cell: `matched` | `multi_word` | `fuzzy` | `unmatched` | `empty` (for `empty`, wordIds are overlooked words, not source words).

5. Confidence scoring
   - LLM confidence: geometric mean and minimum of per-token probabilities for each cell, mapped from Stage 1 logprob offsets to cell character ranges.
   - Grounding confidence: mean confidence of the matched source items — Tesseract's per-word score today; `null` for unmatched cells. **Known limitation:** when the active preset grounds on oar-ocr instead of Tesseract, this "per-word" score is not independent — oar-ocr's Rust crate only scores at the *line* level, so every word split from one line inherits that line's single confidence verbatim (`ocr.rs::oar_region_to_word`). A mis-recognized word inside an otherwise-confident oar-ocr line will not pull that cell's grounding confidence down the way it would under Tesseract. This is a data-availability gap in the crate as currently used (the same PP-OCR model family exposes real per-word scores elsewhere, e.g. the Python RapidOCR prototype's `result.word_results`), not a scoring bug. Whether `cellTrust` should visually distinguish oar-ocr-sourced confidence as wider-uncertainty rather than a precise score is an open product question, not yet decided or implemented.
   - **The agreement axis is "structure source vs grounding source"**, not "LLM vs Tesseract" — which is what it always modelled, and what lets a model‑grounded, model‑verified page still earn green. Values: `agree` (code-matched, including fuzzy; also a clean empty cell — blank output over a blank region is agreement), `image_only` (grounding found nothing matching this value), `disagree` (an empty cell carrying overlooked text — the source shows words where the model output nothing), `self_reported` (a preset with no grounding step, so the model is vouching for itself).
   - `cellTrust` state machine: `high` → green / `medium` → yellow / `low` → red. One ladder over a 0–1 score, applied to a different score per branch, so the thresholds live in exactly one place:
     - `agree` with **both** signals blends them (0.4 × LLM + 0.6 × grounding).
     - `agree` with only **one** numeric signal scores on that one, uncapped. Either side can legitimately be absent — the LLM's value may arrive as a single boundary‑merged token, and a grounding source may report no confidence at all — and agreement was established by the *match*. Feeding the missing term in as zero would cap such a cell at 0.4 and render a correctly‑matched table entirely red, silently.
     - `self_reported` runs the same ladder with the single source standing in for both terms and **caps the result at `medium`**. There is no second opinion, so the green that means "two independent sources agree" is never available.
     - `image_only` keeps its own stricter rule (medium at best, and only above 0.85): grounding looked and found nothing, which is evidence *against* the cell rather than absence of evidence.
   - Fuzzy-matched cells have their computed trust knocked down one level to reflect the approximate agreement. Empty cells bypass the blend — they have no value tokens or matched words to score — and map directly: clean empty → `agree`/`high` (rendered neutrally, not green), overlooked text → `disagree`/`low`. On an ungrounded preset a blank cell is `self_reported`/`medium`: there was no region to check the claim against, so `high` would be unearned, but painting every blank cell red would bury the ones that matter.

6. Memory and residency
   - Rust owns which models are loaded (`llama.rs`). The registry is keyed by **launch identity** — weights, projector, context size, GPU layers, parallelism — not by model id, because the same GGUF at a different `-c` is a different server. A step declares `exclusive` (evict everything else first) or `shared` (coexist, up to two servers).
   - For a two‑model preset, `shared` is a correctness requirement rather than a tuning choice: the executor runs steps *per page*, so evicting between them would unload and reload multi‑gigabyte weights twice per page on a long document. That is what the Accurate preset's higher RAM floor pays for.
   - Unloading stays a UI decision, because *when* to release is a guess about what the user will do next. The server is kept **warm for a short idle window** after a job finishes and is then unloaded; a new job within that window cancels the pending unload, and leaving the session unloads immediately.

7. Human verification
   - Provenance table with per-cell trust coloring. Click any cell to highlight its bounding box on the source document. Unmatched cells show an "unverified source" (`?`) badge; fuzzy-matched cells show an "approximate match" (`≈`) badge. Blank cells render neutrally (no tint, no badge) — unless overlooked source text was found at their location, in which case they render red with a `!` badge and clicking highlights the skipped text. Sessions persisted before the `empty` status existed stored blank cells as `unmatched`; the UI treats a blank value as empty for those.
   - **Correction is part of verification**, so the table is a small spreadsheet rather than a read-only report: a cell edit, a range of cells marked checked at once, or a structural repair (insert/delete/move rows and columns, join two cells or two columns the model split, shift a misaligned row's cells left or right) all happen in place, with undo/redo. Commands are reached three ways — right-click a cell, right-click a row-number/column-letter handle, or the toolbar's *Edit table* menu — all built from one definition so wording and availability can't drift apart.
   - Every command is a **pure transform on the cell grid** (`tableEdits.ts`) returning a rectangular, positionally re-indexed grid, committed through the single existing write path. Two properties make this cheap: the grid stays the one source of truth (the CSV is re-derived from it, so copies and exports always match what's on screen), and cells keep their `wordIds` through structural edits, so a moved or joined cell still highlights the right words on the page. An edit — typed, pasted or cleared — also counts as a manual verification: the user looked at the source and stated what it says, which is exactly what the review worklist is asking for.

8. Export
   - Save the verified output in the user’s chosen format.

## 7. Post‑Install Dependency Setup

The app installer is intentionally small (< 20 MB). Platform‑specific binaries and large AI models are downloaded inside the app on first launch and stored in the user's AppData directory. Subsequent launches skip the wizard if all assets are detected.

### 7.1 Asset Inventory

Platforms below are limited to the currently supported targets (**Windows + macOS on Apple Silicon**); "All" means all *supported* platforms. **Linux is a later addition** — its assets are intentionally not built or pinned yet.

| Asset | Platforms | Primary Source | Fallback | Size |
|---|---|---|---|---|
| Tesseract (zip, incl. tessdata) | Windows | Cloudflare R2 | — | ~38 MB |
| Tesseract (zip, incl. tessdata) | macOS | Cloudflare R2 | — | ~5.7 MB |
| `llama-server` CPU build | Windows | Cloudflare R2 | llama.cpp GitHub releases | ~17 MB |
| `llama-server` CUDA build | Windows | Cloudflare R2 | llama.cpp GitHub releases | ~261 MB |
| CUDA runtime libraries (`cudart`) | Windows (CUDA only) | Cloudflare R2 | — | ~391 MB |
| `llama-server` Metal build | macOS (Apple Silicon) | Cloudflare R2 | llama.cpp GitHub releases | ~10.5 MB |
| PDFium shared library | Windows / macOS (Apple Silicon) | Cloudflare R2 | — | ~3.7 MB |
| `Qwen3.5‑4B‑Q4_K_M.gguf` | All | Cloudflare R2 | HuggingFace (unsloth/Qwen3.5‑4B‑GGUF) | ~2.74 GB |
| `mmproj‑F16.gguf` | All | Cloudflare R2 | HuggingFace (unsloth/Qwen3.5‑4B‑GGUF, `mmproj‑F16.gguf`) | ~672 MB |

Sizes above are the actual R2 object `Content-Length` values (verified 2026-06-16) and match `size_bytes` in the asset manifest, which seeds the progress bar and time-remaining estimate. The bundled `eng.traineddata` ships inside the Tesseract zip rather than as a separate object.

Cloudflare R2 is the primary source for all assets because it offers zero egress fees and consistent global latency. For the two GGUF model files, HuggingFace is available as a fallback if the R2 bucket is unreachable (the wizard retries a failed download once from the fallback URL). The fallback URLs are **pinned to an exact commit revision** of `unsloth/Qwen3.5‑4B‑GGUF` (the same build whose SHA‑256 digests are pinned), not to `main`, so a future re‑quant on that repo cannot change the bytes underneath the pin and silently break the fallback.

PDFium is required because `pdfium-render` binds to a pdfium shared library at runtime, and neither Windows nor macOS ships one. The wizard downloads the upstream prebuilt archive (the library nests under `bin/` on Windows and `lib/` on macOS; extraction flattens it directly into `binaries/`) and the backend binds to that explicit path.

**Which assets an install needs is derived from the chosen preset**, not from a fixed list: `required_assets` asks the preset for its models and the catalog for their files, adds Tesseract only when the preset actually grounds on it, and adds `cudart` only for a Windows CUDA build. The alternative — a hardcoded list — is what caused two mirror‑image bugs worth remembering: `cudart` was omitted unconditionally, so a CUDA install whose 391 MB download failed reported itself *complete* and then died inside `llama-server`; and Tesseract was demanded unconditionally, which would have blocked a model‑grounded install on a download it never makes.

Model files are the join between two tables, and **a test asserts they cover each other exactly**: the catalog says a model needs a file and where it lands; `MODEL_ASSETS` in `setup.rs` pins what bytes that file may be. A model added to the catalog without pinning its download fails the build rather than a user's first extraction, and a pin orphaned by a model's removal fails the same way. Empty digests are rejected outright — `verify_file_hash` skips them by design (that is how not‑yet‑uploaded *binaries* are handled), which would otherwise make an unpinned model a silent hole.

The one deliberate exemption is a model the **user** supplies (§7.5). It carries a `user_supplied` flag, has no declared files, is never downloaded and is never recommended — the exemption is a property of the model rather than an id compared against in three places.

All asset URLs, expected SHA‑256 digests, and destination paths are hardcoded as constants in the Rust backend so they can be audited and updated as a unit when new model or binary versions are pinned. Each manifest entry also records a human‑readable pinned **version** for audit: the llama.cpp build tag (currently `b9596 (18ef86ece)`, shared by all platform binaries since llama.cpp publishes one build per release) for `llama-server`/`cudart`, and the model repo revision (`unsloth/Qwen3.5‑4B‑GGUF@e87f176`) for the two GGUF files. The R2 object keys deliberately strip the build tag, so this field is what ties a pinned SHA‑256 back to a knowable upstream release; refresh it in lockstep with the digests (the build is recoverable any time via `llama-server --version`).

Note: Both supported platforms are now fully provisioned — the macOS Tesseract zip is uploaded to R2 and its SHA‑256 is pinned (`macos/tesseract.zip`), alongside the Windows build, and the HuggingFace fallback URLs for the two GGUF models are real, revision‑pinned links (see above). On a hash mismatch the partial download is discarded either way, and the wizard retries from the fallback URL where one exists (the two GGUF models); an asset with no fallback (the binaries) surfaces an error and asks the user to re‑run setup — which starts clean precisely because the bad partial was discarded (§7.4). **Linux assets (the Linux llama-server build and Linux Tesseract) are deliberately not pinned or uploaded — Linux is a later addition and not required for now.**

### 7.2 Storage Layout

Everything is stored under the Tauri AppData directory, which is derived from the app identifier `com.aidenpaleczny.anchor` (`%APPDATA%\com.aidenpaleczny.anchor` on Windows, `~/Library/Application Support/com.aidenpaleczny.anchor` on macOS). The identifier deliberately does not end in `.app`: macOS Finder treats any directory whose name ends in `.app` as an application bundle/package, which made the data directory display as an opaque package rather than a folder.

```
{AppData}/com.aidenpaleczny.anchor/
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

Detection output drives two recommendations, and the user can override either before downloading:

- `recommended_backend` — `cuda` (NVIDIA, ≥ 4 GB VRAM), `metal` (Apple Silicon), or `cpu` (fallback). (`rocm` for AMD is reserved for the future Linux target and is not offered on the supported platforms.)
- `recommended_preset` — the first preset in catalog order whose RAM and VRAM floor the machine meets (§5). The probe also returns **every** preset with a `supported` flag rather than only the winner, so the picker can show what the hardware rules out instead of hiding the option.

The two treat an unknown VRAM reading oppositely, on purpose. A `None` there means detection was unreliable (Windows' `AdapterRAM` saturates near 4 GB and `nvidia-smi` was unavailable); for the backend that is a reason to assume the card is capable, since guessing wrong costs some speed, while for a preset it disqualifies, since guessing wrong costs a multi‑gigabyte download for a pipeline that then cannot run.

### 7.4 First‑Run Wizard Flow

The wizard runs inside the existing app window; no separate Tauri window is created. It renders in place of the normal app routes until setup completes, then reloads.

```
Welcome → (Configuration) → Install → Complete
```

- **Welcome** — lists what will be downloaded and the estimated total size, and probes hardware in the background. Offers a one‑click *Automatic* path (uses the recommended backend) or a *Custom* path (opens Configuration).
- **Configuration** *(Custom only)* — backend selector (CPU / CUDA / ROCm / Metal), defaulting to the recommended value and filtered to the platform's available builds. (A Tesseract language‑data tier selector — fast / standard / best — is planned but not yet implemented; the wizard currently downloads a single English tier.)
- **Install** — a single step that downloads, verifies, and unpacks every asset. The focal point is one prominent **overall progress bar** (byte‑weighted, so the multi‑GB model dominates and the bar moves smoothly) with a **total time‑remaining estimate** beside it. The estimate is computed live from smoothed download throughput (a 1 s ticker over a trailing window) against the bytes still to go, and is phrased plainly for non‑technical users ("About 8 minutes remaining"). The per‑component list is tucked behind a **"Show details" disclosure, collapsed by default**, to keep the screen minimal; expanded, each component shows its own progress and — for the asset currently downloading — its own time remaining under the `x MB / y MB` readout. Key properties:
  - **Streaming verification:** the SHA‑256 is computed *incrementally from the bytes as they download* (`download_file`), so there is no separate read‑the‑whole‑file‑again verify pass. The `.part` temp file is renamed to its final path **only after** the hash matches — a corrupt/truncated download never leaves a "complete‑looking" file behind. On a mismatch the `.part` is deleted at the point of the decision (`finalize_verified_part`), **always** — not only when a fallback URL exists. This is the exact counterpart to the resume guarantee below, and the two failure modes must not be conflated: an *interrupted* download keeps its bytes because they are good as far as they go, whereas a *verified‑wrong* download's bytes can never become the asset, so keeping them would poison every later attempt — the next run resumes the bad prefix and re‑hashes to the same mismatch, and once the `.part` is object‑sized the server answers `416` and it is re‑hashed from disk to the same end. Discarding in the backend rather than the wizard also covers the cases the wizard cannot see: a mismatch on the *fallback* URL, and the `416` path.
  - **Sequential downloads, overlapped extraction:** downloads run one at a time (they share a single network pipe, so racing them wouldn't be faster), but an archive's extraction (`extract_archive`, run off‑thread via `spawn_blocking`) is kicked off without blocking the *next* asset's download — CPU/disk work overlaps network work.
  - **Resilience:** dropped or stalled connections reconnect and resume from the `.part` via HTTP Range; progress events are coalesced to ~10/sec.
  - **Cancellable / resumable:** the user can cancel at any time (a Cancel button, or by closing the window — which prompts a confirmation rather than silently discarding work). Cancelling advances a monotonic generation counter that the in-flight download polls between chunks, so even the multi-GB model stops promptly; the partially-downloaded `.part` and any already-installed assets are kept, so the next run skips finished assets and resumes the rest. Because nothing reaches its final path until verified, an interrupted install can never leave a corrupt file behind. A `.part` the user never returns to resume is not left forever: a startup sweep (`sweep_stale_partials`) reclaims any `.part` older than a retention window (7 days) — long enough that a genuine resume is never disturbed, short enough that an abandoned multi-GB partial doesn't linger.
- **Complete** — writes the resolved model paths (`modelPath`, `mmprojPath`) and the chosen `hardwareBackend` to persistent settings, then reloads the webview to enter the main app.

**The backend and the preset are both persisted to AppData before the first byte is fetched**, not on success. Both decide what a complete install looks like, and `check_setup_complete` runs before any webview storage is consulted — so recording them only in `localStorage`, or only after the install finishes, would leave the completeness check measuring a half‑finished install against the wrong build or the wrong pipeline. That is exactly the case the check exists for. A preset id the catalog no longer knows (a downgrade, a hand‑edited file) reads as the default rather than failing the launch.

### 7.5 Settings Schema Additions

| Key | Type | Purpose |
|---|---|---|
| `hardwareBackend` | `'cpu' \| 'cuda' \| 'rocm' \| 'metal'` | Chosen acceleration backend; controls which llama‑server build is used |

There is deliberately **no** `llamaServerPath` setting, and no model‑path setting either. `llama.rs` resolves the binary from the canonical AppData layout itself and never reads one, so a stored path could only ever disagree with the path actually launched; since the executor began resolving model paths from the catalog, the same is true of the model. (`modelPath`/`mmprojPath` survive as wizard‑written values that the About page reports for diagnostics — they are a record of the install, not an input to it.)

**Settings ▸ AI model — the user‑supplied GGUF slot.** Rather than free‑text path fields, the section registers one local model file, and the boundaries are the feature:

- **Local files only. Never a URL.** Enforced four independent ways: an explicit URL‑scheme check (so `https://`, `file://` and the rest fail with a message saying *why*), an absolute‑path requirement, an existence‑and‑is‑a‑regular‑file check, and the four‑byte `GGUF` header. Accepting a remote address would turn a settings field into an arbitrary‑download primitive reachable from the webview, bypassing every pin in §7.1.
- **The header check is defence in depth**, not the only barrier — the path reaches `llama-server` as the value of `-m`, which is data passed to a binary resolved from AppData, never something executed. What it buys is that a mis‑picked file is refused *in Settings, with a clear message*, instead of becoming a server crash three screens later.
- **The webview never hands a path to a process spawn.** It hands one to a validator, once; the registration is written to AppData and read back at launch time.
- **Nothing is assumed about the model.** No borrowed stop tokens or system prompt (another family's would at best be ignored and at worst truncate the answer), its own embedded chat template via `--jinja`, no page image and a text‑only prompt to match, and no grounding role — an unverified model is never handed the page's geometry.
- The UI says plainly, before and after the choice, that Anchor checks only that the file is a GGUF: it cannot confirm the origin or that the output is correct, and the confidence colours mean less for it.

### 7.6 Data Removal (the inverse of setup)

Because the wizard puts ~3.5 GB outside the install directory, the app has to be able to take it back out: no uninstaller of ours touches AppData, and leaving multiple GB behind after an uninstall is both a trust problem and a Microsoft Store requirement (policy 10.2.7 — [release.md](release.md) §6.4). Settings ▸ Data therefore offers two whole-install actions beside the existing *Delete all sessions*, both backed by `reset.rs`:

- **Reset Anchor** — wipe, then return to first-run setup, as if freshly installed.
- **Remove all data and quit** — the same wipe, then close, for uninstalling.

They run the identical wipe and differ only in the aftermath. Key properties:

- **Quiesce before deleting.** The wipe first stops `llama-server`, cancels any in-flight OCR job, and advances the setup generation. This is load-bearing, not tidy: the GGUF is memory-mapped by the server, and Windows refuses to delete an open or mapped file at all. Cancelling OCR/downloads likewise stops a worker from writing a page image (or a `.part`) back into a directory that has just been removed. The frontend closes the SQLite pool before invoking, for the same reason.
- **Seal the database, don't just close it.** `Database.load` in `tauri-plugin-sql` re-creates the app directory, the database file, and (via `runMigrations`) the schema — so any query arriving during or just after the wipe silently resurrects `workspace.db` in the folder that was just emptied. The frontend therefore *seals* the module (`db.ts`) before wiping: `getDb()` rejects until the webview reloads. Emitting a session-change event after a wipe is specifically wrong for the same reason — every listener answers it by querying (see `issues.md` § Data/Storage).
- **Scope.** The AppData directory and the config directory (where `tauri-plugin-sql` resolves `sqlite:workspace.db`; the same folder on both supported platforms, resolved separately anyway), plus the `ocr` scratch subtree of the cache directory. Deliberately *not* the cache directory itself: on Windows that resolves to `%LOCALAPPDATA%\<identifier>`, which also holds the **live** WebView2 profile — deleting that under the running webview is impossible (locked) and destabilizing. The only user data the webview holds is settings, which the frontend clears from `localStorage` as part of the same action.
- **Entry-by-entry, with retries.** Each top-level entry is removed independently and retried a few times over ~1s, so a transient lock (a handle released microseconds ago, an AV scanner on the just-closed GGUF) resolves itself and a genuinely stuck file costs that file rather than the whole wipe. Anything that survives is reported by path, with the bytes actually reclaimed — a partial wipe is surfaced, never reported as success, and neither the reload nor the quit happens after one.
- **Recreate only for reset.** The directories are re-created empty on the reset path, because the process keeps running and `tauri-plugin-sql` creates its directory only at startup — a reload into the wizard would otherwise fail to reopen the database. The quit path leaves them gone.
- **Quitting skips Tauri's exit hooks** (`std::process::exit`): `AppHandle::exit` would let `tauri-plugin-window-state` run its save-on-exit hook, recreating the AppData directory with a fresh `.window-state.json` moments after the wipe emptied it. Nothing else needs a graceful shutdown by then — the server is stopped and the database pool is closed.

---

## 8. Future Roadmap & Optional Features

- Generative edits: prompt‑to‑edit workflow (e.g., "Change all dates to MM/DD/YYYY") with accept/decline diffs.
- Mobile companion app: scan on the go and sync to the desktop queue.
- PDF text overlay: inject an invisible machine‑readable text layer over scanned PDFs to make them searchable.

