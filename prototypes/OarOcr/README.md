# oar-ocr — pure-Rust, no-Python feasibility spike

Answers the question from the RapidOCR spike's own scoping discussion: **can a
pure-Rust engine (no Python, no bundled interpreter) give the per-word text +
box + confidence `OcrWord` needs, the way `prototypes/RapidOCR`'s Python
package did?**

[`oar-ocr`](https://github.com/GreatV/oar-ocr) (Apache-2.0) runs the same
PP-OCRv6 model family as the Python spike through ONNX Runtime via the `ort`
crate — no Python anywhere, consistent with the rest of this app's backend and
with `prototypes/Surya`'s own "no Python" stance.

**Result: it works, and it's a real, runnable path — with one accuracy caveat
that matters.** See below.

## What it reuses from the app

Same preprocessing as the Python spike and as `ocr.rs::preprocess_for_ocr`:
grayscale → 2x Lanczos upscale below the 1500px narrow-side threshold → no
binarization/rule-lines/forced DPI. Boxes are divided back by the scale factor
into the original image's coordinate space before being written out.

## Prereqs

Just `cargo` — no Python, no venv, no separate model download step.

```bash
cd prototypes/OarOcr
cargo run -- ../OCR/sample_invoice.png
```

First run downloads ~30MB of ONNX models (PP-OCRv6 "small" det + rec + dict)
from ModelScope into `~/.oar`, SHA-256-verified against hashes pinned inside
the crate itself; later runs reuse the cache with no network access.

Outputs (in `./out`): `<name>.oarocr.json` (OcrWord-shaped: `text`,
`confidence` 0–100, `box_coords`) and `<name>.oarocr.overlay.png`, same format
as the Python spike's outputs for a direct diff.

## Verified against `sample_invoice.png`

73 lines / **108 words**, 2.3s, mean confidence 99.7 — matches the Python
RapidOCR spike's line/word counts on the same page (73/108) almost exactly,
which is a good sign the two are genuinely comparable (same model family,
different runtime).

## The one thing that isn't free: word-level confidence

`oar_ocr::domain::TextRegion` has a `word_boxes: Option<Vec<BoundingBox>>`
field, populated via `.return_word_box(true)` — but reading the crate's own
source (`ctc_word_boxes` in `oarocr/ocr.rs`) shows it's **one box per
character**, not per word, with no whitespace grouping at all. There is also
**no separate confidence score per word or per character anywhere** — `text`
and `confidence` live only on the parent line's `TextRegion`.

This spike's `split_into_words()` reconstructs real word boxes by splitting
the line's text on whitespace and unioning the corresponding run of character
boxes — genuinely useful glue code, not something the crate hands you. But
confidence isn't reconstructable the same way: **every word in this spike's
JSON inherits its parent line's confidence score**, not an independent
per-word one. That's a real regression from both Tesseract (independent
per-word confidence) and the Python RapidOCR path (independent per-word
confidence via `word_results`) — worth knowing before assuming this is a
drop-in `OcrWord` replacement for `confidence.ts`'s per-word blending.

## Packaging notes (relevant to the "how much would it take" scoping)

- **No separate ONNX Runtime binary to distribute at app runtime, at least on
  Windows.** `ort`'s default features downloaded a prebuilt onnxruntime
  distribution *at `cargo build` time* into `%LOCALAPPDATA%\ort.pyke.io\...`
  and linked `onnxruntime.lib` statically — it ends up baked into the compiled
  binary, not something the setup wizard needs to fetch and pin separately the
  way Tesseract's zip is today. (`DirectML.dll` was also pulled in as an
  optional execution-provider dependency and copied next to the exe; dropping
  that feature would remove even that.) **Not verified here for macOS
  ARM64** — this machine is Windows-only — but worth confirming before relying
  on it.
- **Model files are the only real download**, and at ~30MB combined they're
  far smaller than Tesseract's pinned zip. For a real integration, don't rely
  on `auto-download`'s live ModelScope fetch — mirror the exact files (already
  SHA-256-pinned by the crate) to your own R2 bucket and pass them as file
  paths or `include_bytes!`, the same audited-asset pattern `setup.rs`
  already uses for every other download.

## Limitations (it's a spike)

- Images only, single page, no PDF rendering.
- English/Latin dictionary only (`ppocrv6_dict.txt`) — no attempt at
  multi-language model selection.
- Confidence caveat above is the main open question before treating this as a
  real Tesseract replacement, not just "does it run."
