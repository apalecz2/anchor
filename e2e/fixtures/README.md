# E2E fixtures

Small, committed test inputs for the Tier 4 journeys (TEST_PLAN §7, §12). Keep
everything tiny — **never** depend on the real 2.7 GB model or live R2/HuggingFace.

| File | Used by | Notes |
|---|---|---|
| `table.png` | extraction, export, persistence | A clean table screenshot with stable, known cell values. |
| `photo.jpg` | "no-table" rejection / image-only path | A photo with no extractable table. |
| `doc-2page.pdf` | multi-page journey | A 2-page text PDF; each page has a distinct table. |
| `corrupt.pdf` | partial-failure tolerance | Truncated/garbage PDF — one page must error while others render. |
| `renamed.png` | magic-byte rejection (CR:L6) | A non-image (e.g. a small exe) renamed to `.png`. |

## Fixture asset server

The setup journey points `ANCHOR_R2_BASE` at a local HTTP server that serves
stand-in "binaries"/"models" — tiny files whose SHA-256 matches a **test build**
of the asset manifest. This exercises the download/verify/extract/resume paths
without large transfers. Reuse the same fixtures for the Tier 3 `httpmock` tests.

A minimal server: `python -m http.server` over a directory laid out to mirror the
R2 key structure (`binaries/…`, `models/…`, `windows/tesseract.zip`, …).
