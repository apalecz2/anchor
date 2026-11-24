# Testing — implementation status

Companion to [TEST_PLAN.md](TEST_PLAN.md). The plan is the spec; this records what
is implemented and how to run it. **838 automated tests pass** today
(626 frontend — 354 `unit` + 272 `dom` — and 212 Rust `cargo test --lib`).

The Rust count grew roughly eightfold with the manifest-driven pipeline, because that
work moved prompt building, residency, the model client and the pipeline catalog into
Rust. Two of those suites are worth knowing about specifically:

- **Cross-language equivalence** (`pipeline/prompt.rs` ↔ `utils/ocrTransforms.ts`).
  Prompt building was ported to Rust, so the two must agree byte for byte. A shared
  fixture in `app/fixtures/` runs through both languages: the Vitest side *writes* the
  golden files via `toMatchFileSnapshot`, and the Rust side `include_str!`s the same
  files. `buildTableText` is therefore kept in TypeScript with no runtime caller — it
  is the reference the port is held against, and says so in a comment. The fixture
  contains a non-ASCII cell on purpose; measuring string length in UTF-8 bytes instead
  of UTF-16 code units breaks both the golden test and an explicit assertion.
- **Catalog validation** (`pipeline/catalog.rs`). `validate_catalog` takes its inputs
  as parameters rather than reading the statics, so tests can feed it deliberately
  broken catalogs — with few real presets, validating only real data would prove very
  little. Most of that suite asserts *rejection*.

## How to run

```bash
# Frontend (from app/)
npm test                      # both Vitest projects (unit + dom)
npm run test:unit             # Tier 1 pure logic only (node, ms)
npm run test:dom              # Tier 2 components/hooks (jsdom)
npm run test:cov              # coverage → coverage/index.html

# Rust (from app/src-tauri/)
cargo test --lib              # all non-gated unit tests
PDFIUM_TGZ=/path/to.tgz cargo test   # + the gated pdfium archive test

# E2E (from e2e/) — requires a release build + tauri-driver on the host
cargo install tauri-driver --locked
npm ci && npm run e2e

# Pipeline-accuracy eval (from e2e/) — local/manual only, NOT in CI; needs a real
# setup wizard already completed (real models installed, not the fixture server)
# and the corpus placed in e2e/eval-data/ (TEST_PLAN.md §7a)
npm run e2e:eval
```

## What is implemented

| Tier | Status | Notes |
|---|---|---|
| 1 — FE pure logic | **Done** | provenance/confidence/ocrTransforms/exportUtils extended (incl. the grounding dispatch and the generalized agreement axis); new: `promptUtils`, `settings`, `backend`, `sessionEvents`, `searchUtils`, `tableEdits`, `customModel`. Core files at 97–100% line coverage, enforced by per-file `coverage.thresholds` ratchets in `vitest.config.ts` (§11). `contextBudget` moved to Rust (`pipeline/budget.rs`) with its cases. |
| 2 — FE component/hook | **Core done** | `useDialogA11y`, `ConfirmDialog`, `WordEditModal`, `ErrorBoundary`, `ProvenanceTable`, `useTableEditor`, `ExportMenu`, `DocumentViewer`, `DeleteSessionDialog`, `useDocumentExtraction`, `useSetupCheck`, `db.runMigrations`, `sessionActions`, `ConfigStep`, `CompleteStep`, `DownloadStep`, `CustomModelSection`. Shared harness in `src/test/`: `setup.ts` (global), `fixtures.ts` (data builders — §12), `helpers.ts` (DOM doubles). |
| 3 — Rust | **Pure helpers + the pipeline** | hardware (`recommend_backend`, `recommend_preset`, `parse_nvidia_smi`, …), ocr (`upscale_factor`, `map_coord`, `classify_extension`, `ensure_tesseract_tsv_config`), paths, llama (`is_gpu_backend`, `parse_pidfile`, `build_args`, `pick_free_port`, `something_listening`), setup (`is_targz`, `hash_file_range`, `find_marker_dir`, `copy_dir_contents`, `asset_installed`, `required_assets`, the catalog↔pin invariant, `sweep_stale_partials`), and the whole `pipeline/` subtree: `catalog` (validation against broken catalogs), `prompt` (golden-file equivalence), `budget`, `client` (SSE parsing against recorded frames), `surya` (band/block parsing, coordinate conversion), `custom` (GGUF validation), `executor` (run lifecycle, readiness, step dispatch). |
| 4 — E2E | **Scaffolded** | `e2e/` wdio + tauri-driver config and the §7 setup/extraction journey specs. Runnable once the app is built and a fixture asset server is up. |
| 4a — Pipeline-accuracy eval | **Scaffolded** | `e2e/eval/` (§7a): a separate wdio config (`wdio.eval.conf.ts`) scoring real extraction against a 9,064-image ground-truth corpus per pipeline preset. Local/manual only — never run by `npm run e2e`, not wired into CI. Needs a completed real setup (not the fixture server) and the corpus in `e2e/eval-data/` (gitignored, placed manually). |
| 5 — Non-functional | **Seeded** | `src/test/a11y.dom.test.tsx` runs `vitest-axe` on dialogs (zero violations). Perf/CSP/cross-OS remain manual/release-gated per §9. |
| CI | **Wired** | `.github/workflows/test.yml` per §10 (PR: FE coverage + tsc + cargo test/clippy/fmt; nightly: gated Rust + E2E). The pipeline-accuracy eval suite is intentionally excluded. |

## Refactors made for testability

Small pure-function extractions, each wired back into its caller (behaviour unchanged):
`db.runMigrations` exported; `searchUtils.ts` split out of `Search.tsx`; Rust
`parse_nvidia_smi`, `upscale_factor`, `map_coord`, `classify_extension`, `parse_pidfile`.

## Known gaps (need a heavier harness — not yet implemented)

- **`download_file` / `get_asset_manifest` / `check_setup_complete` httpmock integration** (§6.6): these are `#[tauri::command]`s that take a `tauri::AppHandle` (for `emit`), so an httpmock test needs a Tauri mock-app harness (`tauri::test`). The pure helpers they build on are covered; the end-to-end resume/416/mismatch/404/stall branches are exercised by the Tier-4 setup journey instead.
- **Page-render tests** for `Dashboard` / `Session` / `Search` / `Settings` (§6.3) and `SetupWizard`/`Welcome`/`Download` steps beyond `ConfigStep`/`CompleteStep`: their primary flows are covered at the E2E layer; component-level tests are a follow-up.
- **Pre-existing `cargo fmt`/`clippy` deviations** in `build.rs` and `ocr.rs`/`hardware.rs` (unrelated to tests) will surface under the CI fmt/clippy gates until cleaned up separately.
