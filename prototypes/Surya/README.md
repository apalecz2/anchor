# Surya OCR 2 — Python-free MVP prototype

Runs [Datalab's Surya OCR 2](https://huggingface.co/datalab-to/surya-ocr-2)
locally through the **same `llama-server` (llama.cpp) the main app already
installs**, with **no Python** anywhere — no torch, no vllm, no `surya-ocr`
package. One Node script spawns the server and talks to its OpenAI-compatible
endpoint.

This is a feasibility spike for "could Surya be a second extraction engine?"
(see `docs/design.md` and the analysis in the chat that produced this). It does
**full-page OCR only**.

## Can Python be avoided? Yes.

Surya 2 is a single ~650M VLM. **Full-page OCR is one chat-completion call per
page** — the model emits layout + reading order + OCR + tables in its output.
The only parts of the upstream project that need Python are (a) the orchestration
library and (b) the torch text-line detector used for *block mode*. We use
neither.

| Concern | Verdict |
|---|---|
| Runtime | **No Python.** Node spawns `llama-server`, POSTs to `/v1/chat/completions`, parses HTML. |
| Getting the model | **No Python.** Prebuilt GGUFs published at `datalab-to/surya-ocr-2-gguf` — download, no conversion. |
| Text-line detection (torch) | **Not needed** for full-page OCR — skipped entirely. |

## What it reuses from the app

- The **`llama-server` binary** installed by the app's setup wizard at
  `…/com.aidenpaleczny.anchor/binaries/llama-server`. If that isn't present
  (e.g. you haven't run the app on this machine), it falls back to a
  `llama-server` on `PATH` (Homebrew works), or `--llama-server <path>`.
- The same serving model (spawn → wait for `/health` `{"status":"ok"}` → POST)
  as `app/src-tauri/src/llama.rs` + `app/src/features/llama/llamaClient.ts`.

The **model files differ** from the app's Qwen ones — Surya ships its own
`surya-2.gguf` + `surya-2-mmproj.gguf` (~1.5 GB total), downloaded separately.

## Prereqs

- Node 18+ (global `fetch`), `curl`.
- A recent `llama-server` with multimodal (`--mmproj`) support
  (`brew install llama.cpp`, or the app's bundled build).

## Run

```bash
cd prototypes/Surya

# 1. Fetch surya-2.gguf (1.27 GB) + surya-2-mmproj.gguf (205 MB) + chat_template.jinja
node surya.mjs download

# 2. OCR a page — writes artifacts into ./out
node surya.mjs run ../OCR/sample_invoice.png

# then open out/sample_invoice.overlay.html in a browser to see the boxes
```

Outputs (in `./out`):

- `<name>.raw.html` — verbatim model output (`<div data-label data-bbox>` blocks,
  tables as `<table>`, math as `<math>`).
- `<name>.blocks.json` — parsed blocks: `{ label, bbox:[x0,y0,x1,y1], text, html }`.
  **bbox is normalized 0–1000 on each axis.**
- `<name>.overlay.html` — the page image with labelled bounding boxes drawn over
  it (positioned by percentage from the normalized coords — open in a browser).

## How it works (the recovered contract)

Launch:

```
llama-server -m surya-2.gguf --mmproj surya-2-mmproj.gguf \
  -ngl 99 --ctx-size 32768 --parallel 1 --alias surya-ocr-2 --jinja \
  --chat-template-file chat_template.jinja
```

Request (`POST /v1/chat/completions`), one user turn, **no system prompt**:

```jsonc
{
  "messages": [{ "role": "user", "content": [
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } },
    { "type": "text", "text": "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000)." }
  ]}],
  "temperature": 0.0,
  "top_p": 0.1,
  "max_tokens": 12288
}
```

The prompt is the model's **training-time contract** — copied verbatim from the
surya source. Don't paraphrase it. Other documented modes are wired up behind
`--mode layout|table|block` for experimentation.

## Logprobs spike (`logprobs-test.mjs`)

Answers the key question before committing to Surya as a second extraction engine:
**does llama-server return per-token logprobs for Surya in the shape the app's
confidence heatmap needs?**

The app's heatmap (`confidence.ts`) is fed by the streamed shape
`choices[0].logprobs.content[].logprob`. The spike reproduces that exact
request + parse and reports whether the contract holds.

```bash
# OCR a page and check logprobs (spawns the server itself)
node logprobs-test.mjs <image.png>

# Request top-5 alternative tokens per position too
node logprobs-test.mjs image.png --top-logprobs 5

# Attach to a server you already started with `node surya.mjs serve --port 8099`
node logprobs-test.mjs --connect --port 8099 image.png
```

Output is printed to stderr (token count, how many carried a numeric logprob,
mean/min/max, first 15 tokens) plus a one-line **VERDICT**:

- **PASS** — every token carried a logprob; Surya is heatmap-compatible.
- **PARTIAL** — some tokens lacked logprobs; the heatmap degrades gracefully.
- **FAIL** — no logprobs at all; full provenance scoring isn't available for Surya.

The full token stream is also written to `out/<image>.logprobs.json` for inspection.

## Table-grid spike (`table-grid-test.mjs`)

Answers the question the manifest-driven pipeline refactor branches on: **can Surya
supply the table's row and column bands directly, so provenance matching can stop
*inferring* them from word geometry?**

`provenance.ts` already thinks in row bands × column bands — `gridMatchPass` and
`verifyEmptyCellsPass` both call `unclaimedWordsInRegion(words, claimed, rowBand,
colBand)`. Today those bands are inferred by `detectColumnSeparators` (a
whitespace-channel sweep) and `alignRowsToLines` (a Needleman–Wunsch DP), which is
the subject of all six Provenance/Matching post-mortems in `docs/issues.md`.
Surya's `table` mode is prompted to return exactly those bands.

```bash
node table-grid-test.mjs <image.png>                      # spawns its own server
node table-grid-test.mjs --connect --port 8099 image.png  # use a running server
```

It runs **both** modes in one server session — `table` for the bands, `ocr` for the
`<table>` HTML — intersects Row × Col into cell rectangles, cross-checks the derived
grid against the HTML's real shape, and writes `out/<image>.grid.overlay.html` so
"do the cells land in the right place" is answerable by eye.

### Recorded result — `sample_invoice.png`, 2026-09-16: **OUTCOME A**

| | |
|---|---|
| Bands returned | **13 Row × 6 Col**, 0 overlapping, 0 degenerate, 0 out-of-range |
| Cost | **1.8 s / 192 tokens** for the bands (OCR mode: 5.4 s / 783 tokens) |
| vs. the model's own `<table>` | 13 rows — **exact match**. Columns: 6 bands vs 5 HTML columns |

The Col bands are a **perfect contiguous tiling** of the table width:

```
[12–111] [111–212] [212–651] [651–811] [811–910] [910–977]
  dept     number    description  attempted  earned   grade
```

The Δcols=1 is the interesting part, and it favours the bands. The page genuinely
has six visual columns; Surya's own HTML collapses `BUSINESS | 1299E` under a single
`Course` header *and* drops the Grade value from body rows, so its `<table>` is
internally inconsistent (header labels ≠ body semantics) while the geometry is exact.
This is the same failure `docs/issues.md` § Provenance/Matching records as "course
column split into two columns by right-justified content".

**Conclusion for the refactor:** treat the bands as the structural source of truth
and the `<table>` HTML as a source of *cell text only* — not of cell geometry or
column count. Note also that block grounding would be near-useless on this page:
OCR mode returned the whole transcript as **one** `data-label="Table"` block.

## Limitations (it's an MVP)

- Images only (PNG/JPEG/WebP). PDFs would need a render-to-image step — the app
  already has pdfium for this; not wired in here.
- Non-streaming single call; no batching/concurrency tuning.
- No confidence scoring. Surya gives one per-block confidence (mean token prob),
  **not** the app's dual-signal (LLM logprob × Tesseract agreement) heatmap — the
  big open design question if Surya becomes a real engine.
- `--jinja` relies on the chat template embedded in the GGUF (plus the shipped
  `chat_template.jinja` as fallback). If the boxes look wrong, that's the first
  thing to check.
