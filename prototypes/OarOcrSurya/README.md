# oar-ocr + Surya, no LLM pass — feasibility spike

Answers a scoping question from extending the app's pipeline catalog: **could
a preset skip the Qwen structuring pass entirely** — ground words with
oar-ocr, get the table's row/column bands from Surya, and assemble the TSV by
pure geometric intersection, no model call for the table itself?

Today the app can't run this shape at all: `run_page` in
`app/src-tauri/src/pipeline/executor.rs` only ever produces a `PageArtifact`
inside the `Structure`/`Verify` branch (the LLM call), and `validate_catalog`
hard-rejects any preset with no `Structure` step. Building that in for real —
a new `Step` variant, a non-LLM table assembler, and a provenance/confidence
path for "there was no model, the grid *is* the answer" — is a real feature,
not a manifest edit. This spike checks whether the output would even be good
enough to justify that before writing any of it.

## What it does

1. Runs oar-ocr locally (same as `prototypes/OarOcr`) to get word-level text +
   boxes.
2. Asks a running Surya server for the page's row/column bands (same request
   shape as `prototypes/Surya/table-grid-test.mjs` and the app's real
   `GroundGrid` step in `executor.rs`).
3. For each row-band × col-band cell, collects the oar-ocr words whose box
   *center* falls inside both spans, sorts them left-to-right, and joins them
   with a space. That's the entire "structuring" step — no model, no
   correction, pure geometry.

The Surya-parsing code (`parse_bands`, `declared_grid`, `NormBox`/`Span`) is
copied from `app/src-tauri/src/pipeline/surya.rs` rather than reimplemented,
so this spike's grid math matches the app's exactly.

## Prereqs

- `cargo` (no Python).
- A Surya server already running — reuses `prototypes/Surya`'s existing
  model files and launcher rather than duplicating server-lifecycle code:

  ```bash
  cd prototypes/Surya
  node surya.mjs serve --port 8099
  ```

  Leave that running in its own terminal.

## Run

```bash
cd prototypes/OarOcrSurya
cargo run -- ../OCR/sample_invoice.png --port 8099
```

First run downloads oar-ocr's ~30MB of ONNX models (same as
`prototypes/OarOcr`), cached after that.

Outputs (in `./out`):

- `<name>.notool.tsv` — the assembled table. **This is the thing to judge.**
- `<name>.notool.overlay.png` — the original image with Surya's row bands
  (blue) and column bands (magenta) drawn as lines, and oar-ocr's word boxes
  (green) — open it to see at a glance whether words are landing in the cells
  they should.
- `<name>.notool.unclaimed.json` — words whose box center fell outside every
  row×col cell (e.g. a title line above the table, or a band that didn't
  quite reach the page edge). A large list here means the grid isn't covering
  the words well, independent of whether the *assigned* cells look right.

## What this can't do (and an LLM pass currently does)

- **No semantic correction.** Two adjacent OCR words in one cell (e.g. a
  misread split like "S ampl e") become "S ampl e" verbatim — an LLM
  reading the image would just write "Sample."
- **No handling of wrapped/merged cells beyond raw geometry.** A cell whose
  content spans two visual lines only works if both lines' words fall in the
  same row band; Surya's bands are per-visual-row, so a wrapped cell likely
  splits across two output rows here, where an LLM (or the app's real DP-based
  row alignment in `provenance.ts`) would recombine it.
- **No column-count correction.** If Surya under- or over-segments columns,
  the TSV directly reflects that — there's no TSV-column-count anchor the way
  `detectColumnSeparators` uses in the real (LLM + inferred grid) path.
- **Empty cells and header detection are not special-cased** — every row
  (including the header) is treated identically.

If the TSV output looks close to correct on real documents despite these
gaps, that's the signal worth pursuing the real app feature over. If it's
noticeably worse than the Qwen-structured output, that's your answer too —
cheaply, without touching the app.
