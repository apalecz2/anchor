# RapidOCR — word-level accuracy spike

Feasibility spike for "could RapidOCR replace Tesseract as the word-level
grounder?" (see the Tesseract-bottleneck discussion in `docs/issues.md` §
OCR/Preprocessing). RapidOCR is a from-scratch engine (PaddleOCR's detection +
recognition models exported to ONNX), not a drop-in Tesseract fork, but it
produces the same *shape* of output — per-word text, box, confidence — so it's
a direct, comparable substitute for `OcrWord` if it's meaningfully more
accurate on the pages where Tesseract is struggling.

This is a read-only spike: it does not touch `app/`. It runs against a single
image and writes its findings to `./out` so they can be eyeballed and compared
against the app's own Tesseract output on the same page.

## What it reuses from the app

The preprocessing step is copied **bit-for-bit** from
`app/src-tauri/src/ocr.rs::preprocess_for_ocr`, not reinvented, so a
side-by-side comparison against Tesseract isn't confounded by different image
prep:

- Grayscale conversion (before resizing, not after — antialiased stroke
  shoulders fatten up correctly).
- 2x Lanczos upscale, applied only when the narrow side is under 1500px
  (`UPSCALE_NARROW_SIDE_THRESHOLD` in `ocr.rs`) — mirrors the image-upload
  path (`allow_upscale: true`); PDFs render at 2000px already and skip this.
- **No binarization, no rule-line removal, no forced DPI** — the real pipeline
  deliberately dropped these (see `docs/issues.md` § OCR/Preprocessing #1);
  carrying them into this spike would bias the comparison against a fix that's
  already been made once.

Boxes are divided back by the scale factor before being written out, so
`box_coords` is in the **original image's pixel space** — the same coordinate
invariant `ocr.rs`'s own doc comment calls out (`map_coord`), and the one
`app/src/components/DocumentViewer` assumes everywhere.

## Prereqs

```bash
cd prototypes/RapidOCR
python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
```

First run downloads RapidOCR's det/cls/rec ONNX models (~15 MB total) into an
internal cache — no separate download step needed, unlike the Surya spike's
GGUF fetch.

## Run

```bash
# Default: ../OCR/sample_invoice.png (the same sample the Tesseract prototype uses)
python rapid_ocr_test.py

# Or point it at a page the app is actually struggling on
python rapid_ocr_test.py /path/to/problem_page.png
```

Outputs (in `./out`):

- `<name>.rapidocr.json` — one entry per detected word/phrase:
  `{ text, confidence (0-100, matching OcrWord's scale), box_coords: {left, top, width, height} }`.
- `<name>.rapidocr.overlay.png` — the **original** (pre-preprocessing) image
  with boxes drawn over it, colored by confidence (green ≥85, orange ≥60, red
  below) — open it directly to eyeball placement and confidence at a glance.

Console output also prints a confidence summary (mean/min/max) and the
preprocessed vs. original dimensions, so a quick run tells you whether
upscaling even kicked in for that page.

## Comparing against Tesseract

Run the app (or `prototypes/OCR/tesseract_table_ocr.py`) on the same page and
diff:

- **Text accuracy** — does RapidOCR get the characters Tesseract garbles?
  That's the whole question; nothing here answers it automatically, look at
  the two outputs side by side.
- **Box granularity** — RapidOCR's detector groups by text line/phrase more
  aggressively than Tesseract's word boxes in some layouts. If boxes come back
  coarser than Tesseract's (multiple words per box), that changes what
  `provenance.ts`'s grid matcher can resolve down to and is worth noting even
  if the text itself is more accurate.
- **Confidence calibration** — RapidOCR's score is the recognition model's own
  probability, not directly comparable to Tesseract's; don't assume the same
  numeric thresholds (`FUZZY_THRESHOLD`, `cellTrust`'s 0.85/0.65 rungs) carry
  over unchanged if this becomes a real second engine.

## Limitations (it's a spike)

- Images only — no PDF rendering (same limitation as the Surya spike; the app
  already has pdfium for this, not wired in here).
- Single image per run, no batching.
- Uses the default (English-oriented) detection/recognition models RapidOCR
  ships; no attempt at model selection or fine-tuning.
- Confidence is per-word, but its distribution/meaning hasn't been validated
  against `cellTrust`'s assumptions — treat the JSON as raw material for that
  investigation, not a verdict.
