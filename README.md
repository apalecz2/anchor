# Artifact

A local-first desktop application for extracting structured data from non-machine-readable documents -- scanned PDFs, photos, image-based tables -- with zero API cost and no data leaving the machine.

## How It Works

1. **Ingest** -- upload a PDF, PNG, or JPEG; the app renders and caches each page.
2. **OCR** -- Tesseract extracts word-level bounding boxes and confidence scores.
3. **Extract** -- a local vision LLM (Qwen3.5-4B via llama.cpp) reads the image and spatially-arranged OCR text and produces a clean TSV table.
4. **Provenance** -- a deterministic code pass walks the CSV cells and OCR words in parallel to link each output cell back to its source region in the document.
5. **Verify** -- a split-pane UI shows the document on the left and the extracted table on the right; clicking any cell highlights its source on the document. Cells are color-coded by a confidence score derived from LLM token log-probabilities, Tesseract word confidence, and source agreement.
6. **Export** -- save the verified output in your chosen format.

All processing runs on-device. No network calls are made.

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 19, TypeScript, Vite |
| Desktop shell | Tauri 2 (Rust) |
| Styling | Tailwind CSS 4 |
| Database | SQLite (tauri-plugin-sql) |
| OCR | Tesseract (not in git -- see Setup) |
| PDF rendering | pdfium-render (Rust) |
| LLM | Qwen3.5-4B-Q4_K_M via llama.cpp (not in git -- see Setup) |

## Repository Structure

```
app/          # Main application -- React frontend + Tauri/Rust backend
prototypes/   # Early feasibility experiments
docs/         # Design spec, architecture docs, issues, to-do
tests/
scripts/
```

See [app/README.md](app/README.md) for build instructions and [docs/design.md](docs/design.md) for the full system design.

## Setup

Large dependencies (Tesseract, llama-server, GGUF models) are not bundled in the installer. On first launch an in-app wizard detects your hardware and downloads everything automatically to the OS app-data directory.

See [app/README.md](app/README.md) for the expected AppData layout and dev setup instructions.

## Quick Start

Prerequisites: [Node.js](https://nodejs.org) and [Rust](https://rustup.rs) -- see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform-specific steps.

```bash
cd app
npm install
npm run tauri dev
```
