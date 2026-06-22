# Testing — implementation status

Companion to [TEST_PLAN.md](TEST_PLAN.md). The plan is the spec; this records what
is implemented and how to run it. **245 automated tests pass** today
(218 frontend across Vitest's `unit` + `dom` projects, 27 Rust `cargo test`).

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
```

## What is implemented

| Tier | Status | Notes |
|---|---|---|
| 1 — FE pure logic | **Done** | provenance/confidence/ocrTransforms/exportUtils/contextBudget extended; new: `promptUtils`, `settings`, `backend`, `sessionEvents`, `searchUtils`. Core files at 97–100% line coverage, enforced by per-file `coverage.thresholds` ratchets in `vitest.config.ts` (§11). |
| 2 — FE component/hook | **Core done** | `useDialogA11y`, `ConfirmDialog`, `WordEditModal`, `ErrorBoundary`, `ProvenanceTable`, `ExportMenu`, `DocumentViewer`, `DeleteSessionDialog`, `llamaClient`, `useDocumentExtraction`, `useSetupCheck`, `db.runMigrations`, `sessionActions`, `ConfigStep`, `CompleteStep`. Shared harness in `src/test/`: `setup.ts` (global), `fixtures.ts` (data builders — §12), `helpers.ts` (DOM doubles). |
| 3 — Rust | **Pure helpers done** | hardware (`recommend_backend`, `parse_nvidia_smi`, …), ocr (`upscale_factor`, `map_coord`, `classify_extension`, `ensure_tesseract_tsv_config`), paths, llama (`is_gpu_backend`, `parse_pidfile`, `pick_free_port`, `something_listening`), setup (`is_targz`, `hash_file_range`, `find_marker_dir`, `copy_dir_contents`, `asset_installed`, `sweep_stale_partials`, `accept_unpinned_or_err`). |
| 4 — E2E | **Scaffolded** | `e2e/` wdio + tauri-driver config and the §7 setup/extraction journey specs. Runnable once the app is built and a fixture asset server is up. |
| 5 — Non-functional | **Seeded** | `src/test/a11y.dom.test.tsx` runs `vitest-axe` on dialogs (zero violations). Perf/CSP/cross-OS remain manual/release-gated per §9. |
| CI | **Wired** | `.github/workflows/test.yml` per §10 (PR: FE coverage + tsc + cargo test/clippy/fmt; nightly: gated Rust + E2E). |

## Refactors made for testability

Small pure-function extractions, each wired back into its caller (behaviour unchanged):
`db.runMigrations` exported; `searchUtils.ts` split out of `Search.tsx`; Rust
`parse_nvidia_smi`, `upscale_factor`, `map_coord`, `classify_extension`, `parse_pidfile`.

## Known gaps (need a heavier harness — not yet implemented)

- **`download_file` / `get_asset_manifest` / `check_setup_complete` httpmock integration** (§6.6): these are `#[tauri::command]`s that take a `tauri::AppHandle` (for `emit`), so an httpmock test needs a Tauri mock-app harness (`tauri::test`). The pure helpers they build on are covered; the end-to-end resume/416/mismatch/404/stall branches are exercised by the Tier-4 setup journey instead.
- **Page-render tests** for `Dashboard` / `Session` / `Search` / `Settings` (§6.3) and `SetupWizard`/`Welcome`/`Download` steps beyond `ConfigStep`/`CompleteStep`: their primary flows are covered at the E2E layer; component-level tests are a follow-up.
- **Pre-existing `cargo fmt`/`clippy` deviations** in `build.rs` and `ocr.rs`/`hardware.rs` (unrelated to tests) will surface under the CI fmt/clippy gates until cleaned up separately.
