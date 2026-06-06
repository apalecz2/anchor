# System Design Document — Local-First AI Data Extraction Tool

## 1. Executive Summary

This project aims to build a desktop application that acts as a "Cursor for local data extraction." It streamlines the transformation of non‑machine‑readable data (e.g., written notes, image‑based tables, flat PDFs) into structured, machine‑readable formats.

By prioritizing a local‑first architecture, the application guarantees strict data privacy for sensitive information, eliminates recurring API costs, and enables unlimited offline processing. The system relies on human verification instead of tedious manual data entry, using an intelligent split‑screen interface to highlight uncertainties and cross‑reference extracted data.

## 2. Technical Stack

| Component            | Technology                             | Rationale                                                                 |
|----------------------|----------------------------------------|---------------------------------------------------------------------------|
| Front-End            | React with TypeScript                  | Robust, type‑safe, highly interactive UI (essential for split‑screen/heatmap features).
| Framework            | Tauri                                  | Lightweight cross‑platform desktop framework with lower overhead than Electron.
| AI Model(s)          | Qwen3.5‑4b (w/ Vision), Gemma4:e4b     | Run via llama.cpp; handles vision tasks and OCR validation/cleanup locally.
| OCR Engine           | Tesseract                              | Fallback/baseline text extraction, useful for low‑end systems and verification.
| Image Preprocessing  | imageproc (Rust, pure)                 | Pre‑OCR binarization, denoising, and rule‑line removal; no system OpenCV dependency.

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
- Unmatched cell badge: cells the model read from the image with no corresponding OCR word are marked with an "unverified source" indicator rather than silently dropped.

## 4. User Stories

| User Persona        | Story                                                                    | Goal / Value                                                          |
|---------------------|--------------------------------------------------------------------------|------------------------------------------------------------------------|
| Non‑Technical User  | "I want to attach large PDFs containing a mix of text and tables."       | Quickly receive clean CSVs for each table without manual entry.       |
| Non‑Technical User  | "I want to upload pictures of my handwritten notes."                    | Effortlessly digitize and use the text.                                |
| Any User           | "I want to click on extracted data and see exactly where it came from."  | Establish trust and simplify verification.                             |
| Any User           | "I want the app to visually flag areas it is unsure about."             | Quickly spot and fix errors without full manual proofreading.           |

## 5. System Requirements & Hardware Adaptability

- Cross‑platform: macOS, Windows, Linux.
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
   - A binarized, denoised, line-removed copy of the image is produced in a separate file for Tesseract only. The original image is unchanged and is what the vision model and UI see.
   - Pipeline (order is strict): optional 2× upscale (image-upload path only, when the narrow side < 1500 px) → grayscale → mild median denoise → adaptive local binarization → table rule-line removal.
   - **Coordinate alignment:** upscaling is the only geometric transform. When applied, every Tesseract bounding box returned after OCR is divided by the scale factor before being stored, so all box coordinates remain in the original image's coordinate space. PDF inputs are already high-res (2000 px); they are never upscaled, so their scale factor is always 1.0.
   - **Rule-line removal:** long horizontal and vertical runs of black pixels (≥ 50% of the image dimension) are set to white after binarization. This is a tonal (pixel-value) transform — it does not move pixels and has no effect on coordinate alignment. It eliminates the `|` and `-` glyphs that Tesseract reads from table grid lines.
   - Binarization uses adaptive local thresholding (block radius 12 px), which handles uneven lighting better than a global threshold.

3. Context assembly
   - Sanitize OCR words once: strip column-rule pipe glyphs, filter empties, assign stable integer IDs. This single array feeds both downstream formatters.
   - Two formatters from the same array: (a) **spatial text** — words placed at character columns proportional to pixel X position, preserving column alignment for the vision model; (b) **indexed word list** — each word with ID, text, bounding box, and confidence — used by Stage 2a matching.

4. Stage 1 — Structured extraction (LLM, vision)
   - The vision-language model receives the document image and spatially-arranged OCR text. Settings: temperature 0, top‑k 1, no presence penalty, no grammar constraint. Output: clean CSV with the first row as the header.
   - Token log‑probabilities are collected with cumulative character offsets during streaming for downstream confidence scoring.

4a. Stage 2a — Provenance by code (deterministic)
   - Parallel reading-order walk: iterate CSV cells and OCR words simultaneously in the same left-to-right, top-to-bottom order.
   - `matchFromCursor`: bounded lookahead of 12 words from the current cursor position. Handles single-word and multi-word cell values. Cursor advances only on a match — one unmatched cell cannot desync the rest of the table.
   - Produces `CellProvenance` per cell: `matched` | `multi_word` | `unmatched`.

5. Confidence scoring
   - LLM confidence: geometric mean and minimum of per-token probabilities for each cell, mapped from Stage 1 logprob offsets to cell character ranges.
   - OCR confidence: mean Tesseract word confidence of matched words; `null` for unmatched cells.
   - Agreement: `agree` (code-matched), `image_only` (no OCR source), `disagree` (Stage 2b mismatch, future).
   - `cellTrust` state machine: `high` → green / `medium` → yellow / `low` → red. Drives the per-cell UI heatmap.

6. Memory unloading
   - Unload the AI model from RAM after Stage 1 completes to free resources (unless queued jobs remain). The vision projector is not needed for Stage 2.

7. Human verification
   - Provenance table with per-cell trust coloring. Click any cell to highlight its bounding box on the source document. Unmatched cells show an "unverified source" badge.

8. Export
   - Save the verified output in the user’s chosen format.

## 7. Future Roadmap & Optional Features

- Generative edits: prompt‑to‑edit workflow (e.g., "Change all dates to MM/DD/YYYY") with accept/decline diffs.
- Mobile companion app: scan on the go and sync to the desktop queue.
- PDF text overlay: inject an invisible machine‑readable text layer over scanned PDFs to make them searchable.
