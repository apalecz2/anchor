# Test Plan — Anchor (DataExtractionAI)

**Status:** authored 2026-06-17 · **Scope:** the shippable app (`app/` React frontend + `app/src-tauri/` Rust backend). Prototypes (`prototypes/`) are out of scope.
**Supported platforms:** Windows + macOS (per [design.md §5](design.md)). Linux paths exist but are unsupported placeholders — they are smoke-checked for compilation only, not validated.

This plan is the single source of truth for **what to test, how to implement it, and how to run it.** It is organized as a test pyramid (§3), then a **file-by-file coverage matrix** (§6) so nothing is missed, then cross-cutting suites (§7–§11) covering everything from a hard process crash down to an individual button press.

---

## 1. Testing Goals & Principles

The product's value rests on four claims; tests exist primarily to defend them:

1. **Provenance is correct** — every output cell maps to the right source pixels (design §3.3, §4a). A wrong highlight silently destroys user trust.
2. **Confidence is honest** — the heatmap never reports "high" for a value it has no signal for (design §5). Inflated trust is worse than no trust.
3. **Local-first never loses or leaks data** — setup downloads verify before use, edits persist, deletes clean up, nothing leaves the machine (design §1, §3.1, §7).
4. **The app degrades gracefully** — a bad page, a dropped download, a crashed model server, a corrupt DB row, or a malformed file never blanks the window or strands the user.

**Principles**
- **Push tests down the pyramid.** Pure logic (provenance/confidence/TSV/export) is the highest-risk *and* cheapest to test — it must have exhaustive unit coverage. Reserve slow E2E for true integration risk.
- **Determinism.** No test depends on a real model, network, wall-clock timing, or GPU. Time, network, IPC, and the DB are faked at the boundary.
- **Test behavior, not markup.** Assert on roles/text/callbacks, not Tailwind classes (except where a class *is* the behavior, e.g. trust-color mapping).
- **Every fixed regression gets a test.** The findings in [CODE_REVIEW.md](../CODE_REVIEW.md) / [OUTSTANDING.md](../OUTSTANDING.md) are a ready-made high-value case list — they are referenced inline below as `(CR:H2)` etc.

---

## 2. Current State (baseline)

| Layer | Today | Gap |
|---|---|---|
| FE pure-logic unit | Vitest (node env), **50 tests** in `provenance` (incl. grid cross-check), `confidence`, `ocrTransforms`, `exportUtils`, `contextBudget` | Missing `promptUtils`, `settings`, `backend`, `sessionEvents`; partial coverage of existing files |
| FE component/hook | **none** (vitest is node-only, no jsdom/RTL) | Entire UI layer — buttons, dialogs, hooks, pages |
| FE integration (IPC/DB mocked) | **none** | `invoke`/`listen`/plugin-sql flows |
| Rust unit | **1 test**, env-gated (`extract_pdfium_flattens_library`) | Hashing, manifest, download, hardware, paths, OCR preprocess |
| Rust integration | **none** | `download_file` over HTTP, archive extraction, server lifecycle |
| E2E | **none** | Full app, setup wizard, crash recovery |
| Non-functional | **none** | a11y, performance, security/CSP, cross-platform |

---

## 3. Test Architecture (the pyramid)

```
        ╱╲          Tier 5  Manual / exploratory + non-functional (a11y, perf, security, cross-OS)
       ╱  ╲                  — release gating, not per-commit
      ╱────╲        Tier 4  E2E (tauri-driver + WebdriverIO) — full app, real backend, fixtures
     ╱      ╲                — the "app crashes to button presses" end of the spectrum
    ╱────────╲      Tier 3  Rust unit + integration (cargo test, httpmock, tempfile)
   ╱          ╲     Tier 2  FE component/hook (Vitest + jsdom + Testing Library + mockIPC)
  ╱────────────╲    Tier 1  FE pure-logic unit (Vitest node) — broadest, fastest, exhaustive
 ────────────────
```

| Tier | Runner | Speed | Runs | Owns |
|---|---|---|---|---|
| 1 | `vitest` (node) | ms | every commit / pre-push | pure functions |
| 2 | `vitest` (jsdom) | ms–s | every commit | components, hooks, IPC-mocked flows |
| 3 | `cargo test` | s | every commit (gated tests opt-in) | Rust logic + HTTP/archive integration |
| 4 | `wdio` + `tauri-driver` | min | CI on PR + nightly | full user journeys, crash recovery |
| 5 | tooling-assisted manual | — | per release | a11y audit, perf budgets, CSP, Win/mac matrix |

---

## 4. Tooling & One-Time Setup

### 4.1 Frontend (add to `app/`)

```bash
# Tier 2 component testing + coverage + a11y
npm i -D jsdom @testing-library/react @testing-library/user-event \
        @testing-library/jest-dom @vitest/coverage-v8 vitest-axe
# Tauri IPC mocking is already available via @tauri-apps/api/mocks (installed dep)
```

Split the Vitest config into two **projects** so pure-logic stays node-fast while component tests get a DOM. Replace `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      { // Tier 1 — pure logic, node, no DOM
        test: { name: 'unit', environment: 'node',
                include: ['src/**/*.test.ts'], exclude: ['src/**/*.dom.test.{ts,tsx}'] },
      },
      { // Tier 2 — components/hooks, jsdom
        test: { name: 'dom', environment: 'jsdom',
                include: ['src/**/*.dom.test.{ts,tsx}'],
                setupFiles: ['src/test/setup.ts'] },
      },
    ],
    coverage: { provider: 'v8', reporter: ['text', 'html', 'lcov'],
                include: ['src/**'], exclude: ['src/**/*.test.*', 'src/main.tsx'] },
  },
});
```

`src/test/setup.ts` (shared DOM setup):

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

// jsdom lacks these — components depend on them.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any;
Element.prototype.scrollIntoView = vi.fn();
```

**Naming convention:** Tier 1 → `*.test.ts`, Tier 2 → `*.dom.test.tsx`. This keeps node-fast logic tests isolated from jsdom and is the single discriminator the config uses.

**Mocking the Tauri boundary** — a shared helper `src/test/tauriMocks.ts` wraps `@tauri-apps/api/mocks` `mockIPC`/`clearMocks` and a fake `Database` so component tests never touch a real backend:

```ts
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
// register handlers per command: process_document, get_asset_manifest, download_file,
// check_setup_complete, get_setup_paths, start/stop_llama_server, etc.
// Provide a fake getDb() via vi.mock('../lib/db', …) returning an in-memory query stub.
```

### 4.2 Rust (add to `app/src-tauri/Cargo.toml` `[dev-dependencies]`)

```toml
[dev-dependencies]
httpmock = "0.7"      # local HTTP server for download_file (resume, 206/416/404, stall)
tempfile = "3"        # scratch dirs for archive extraction / .part files
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time"] }
```

Pattern: keep pure helpers (`parse_content_range_total`, `recommend_backend`, `extract_gpu_vendor`, `accept_unpinned_or_err`, hash range, `is_targz`, `find_marker_dir`) directly unit-testable; gate anything needing the real Tesseract/pdfium binary behind an env var exactly as the existing `PDFIUM_TGZ` test does, so plain `cargo test` stays green on a clean checkout.

### 4.3 E2E (new top-level `e2e/` workspace)

```bash
# host: tauri-driver bridges WebDriver to the Tauri webview (WebView2 on Win, WKWebView on mac)
cargo install tauri-driver --locked
npm i -D @wdio/cli @wdio/local-runner @wdio/mocha-framework webdriverio
```
E2E runs against a **release build with a test profile** that points `R2_BASE` at a local fixture asset server (small stand-in binaries/models) so the wizard is exercised without 3.5 GB downloads. Real extraction journeys use a **tiny bundled GGUF + fixture documents** with asserted-stable output, or stub the llama-server HTTP endpoint.

---

## 5. How to Run

```bash
# Frontend
npm test                      # all Vitest projects (unit + dom) once
npm test -- --project unit    # Tier 1 only (fast pre-commit)
npm run test:watch            # watch
npm test -- --coverage        # coverage report → coverage/index.html

# Rust  (from app/src-tauri)
cargo test                    # all non-gated unit + integration tests
PDFIUM_TGZ=/path cargo test    # include the pdfium/archive gated tests
TESSERACT_TEST=1 cargo test    # include OCR tests needing a real tesseract on PATH

# E2E  (from e2e/)
npm run e2e                    # build test profile + tauri-driver + wdio
npm run e2e -- --spec setup    # single journey
```

Add `package.json` scripts: `"test:unit"`, `"test:dom"`, `"test:cov"`, `"e2e"`. See §10 for CI wiring.

---

## 6. File-by-File Coverage Matrix

Legend — **Tier**: 1 pure / 2 component / 3 Rust / 4 E2E. **Priority**: 🔴 must-have (core value / known-risk), 🟡 should-have, ⚪ smoke only.

### 6.1 Frontend — pure logic (Tier 1, `*.test.ts`)

| File | Pri | Functions | Cases to cover |
|---|---|---|---|
| `features/extraction/provenance.ts` | 🔴 | `matchCellsToOcr`, `matchFromCursor`, `fuzzyMatchPass`, `gridMatchPass`, `getCellSourceBox`, `sanitizeWordsForProvenance`, `levenshtein/similarity/normalize` | *Has tests — extend.* 12-word lookahead boundary (match at edge vs just beyond); multi-word cell spanning exactly the window; cursor never rewinds; fuzzy bounds cannot steal a word an adjacent cell already claimed `(CR:F2)`; fuzzy lower bound = prevMatch+1 / upper = nextMatch; 0.8 threshold edge (0.79 reject / 0.80 accept); empty CSV, empty OCR, all-unmatched row; UUID stability after reorder/delete `(CR:H2)`; pipe-glyph sanitize keeps pipe-only reads. **Grid cross-check `(CR:F2)`:** a reading-order-desynced cell is recovered from its row band (matched siblings) ∩ column band (other matched rows); no recovery when a whole column has no anchor; an in-band but sub-threshold candidate stays `unmatched`; a claimed word is never re-stolen |
| `features/llama/contextBudget.ts` | 🔴 | `estimateTokens`, `estimateExtractionBudget` | *Has tests.* ~4 chars/token estimate (`''`→0, `abcd`→1, `abcde`→2); budget reserves `IMAGE_TOKEN_ESTIMATE` and leaves the rest for output on a small prompt (`overflow=false`); a prompt that consumes nearly the whole context flags `overflow=true` (< `MIN_OUTPUT_TOKENS` room); `availableOutputTokens` never negative `(CR:F3)` |
| `features/extraction/confidence.ts` | 🔴 | `parseTSVWithOffsets`, `mapLogprobsToCells`, `cellTrust`, `computeProvenanceCells` | *Has tests — extend.* TSV: opening/closing fences, CRLF, blank rows between data, trailing tab → empty cell, single column, ragged rows; **char-offset alignment** — a logprob at offset X maps to the cell whose `[start,end)` contains it; `cellTrust` every branch: `disagree`→low, `image_only` ≥0.85→medium else low, blended ≥0.85 ∧ llmMin≥0.5→high, blended<0.5 gate keeps high out, ≥0.65→medium, else low; `computeProvenanceCells`: null logprobs excluded from mean (not treated as prob 1.0) `(CR:M17)`, OCR confidence resolved by UUID, `ocr=null` when unmatched, fuzzy knockdown high→medium / else→low |
| `utils/ocrTransforms.ts` | 🔴 | `groupWordsIntoLines`, `buildTableText`, `generateLinesFromWords`, `sortWords`, `lineThreshold` | *Has tests — extend.* Transitive clustering on an intransitive run A≈B≈C, A≉C `(CR:H9)`; tilt/drift (gap-to-previous, not anchor-to-first); single line; empty input; `buildTableText` column anchors from header, right-justified wide-cell content stays in left column (no phantom trailing column), padding to char anchors, single-word header fallback; `lineThreshold` floor of 2px |
| `features/export/exportUtils.ts` | 🔴 | `escCsv`, `toCsv`, `toHtml`, `toMarkdown`, `toPlainText`, `buildFileStem`, `saveXlsxWithDialog` | *Has tests — extend.* CSV: quote on comma/quote/newline/CR, double-quote escaping, CRLF row joins `(CR:M1)`; HTML escapes `& < > "`; Markdown col widths (min 3, ragged rows pad), separator length; plaintext tab-join; `buildFileStem`: strip extension, illegal→`_`, collapse `__`, trim edge `_`, 50-char cap, empty/null→`extraction`, multipage `_pN_extract` suffix. XLSX is built server-side (`export.rs`, see §6.6), so `saveXlsxWithDialog` only needs the dialog-cancel no-op and the `invoke('export_xlsx', { rows, destPath })` call shape asserted (mock `@tauri-apps/plugin-dialog` + `@tauri-apps/api/core`) |
| `features/llama/promptUtils.ts` | 🟡 | `parseCSV`, `parseFields`, `compactOcrText`, `buildOcrExcerpt` | *No tests yet.* Quoted fields with commas, escaped `""`, leading/trailing fence strip, blank-line skip, trimming; `compactOcrText` whitespace collapse + empty-line drop; `buildOcrExcerpt` maxLines/maxChars truncation + `[truncated…]` marker |
| `lib/settings.ts` | 🟡 | `readSetting`, `writeSetting`, `VALIDATORS` | *No tests yet (needs localStorage → jsdom or stub).* Valid value passes through; invalid `theme`/`hardwareBackend` → `DEFAULTS` `(CR:L7)`; `null` → default; free-text key passthrough; `THEMES`/`HARDWARE_BACKENDS` single-source-of-truth (validator stays in sync with type) |
| `features/setup/backend.ts` | 🟡 | `backendWarning` | *No tests yet.* cuda+non-NVIDIA→warn, cuda+VRAM<4096→warn (msg shows GB), cuda+NVIDIA+≥4096→null, cuda+NVIDIA+VRAM null→null, rocm+non-AMD→warn, rocm+AMD→null, metal→null, cpu→null; every `Backend` has a label+description |
| `features/sessions/sessionEvents.ts` | ⚪ | `emitSessionChange`, `subscribeToSessionChanges` | emit→listener receives detail; unsubscribe stops delivery; `window===undefined` no-op (SSR guard) |

### 6.2 Frontend — components & hooks (Tier 2, `*.dom.test.tsx`)

| File | Pri | What to simulate / assert |
|---|---|---|
| `hooks/useDialogA11y.ts` | 🔴 | Escape → `onClose`; Tab from last → first, Shift+Tab from first → last (focus trap); initial focus to first focusable, else container; focus restored to opener on unmount; `active:false` registers no listeners; no-focusable-child fallback `(CR:L10)` |
| `components/ConfirmDialog.tsx` | 🔴 | Renders title/description when `open`; `null` when closed; Confirm/Cancel buttons fire callbacks; backdrop click → `onCancel`, inner click does **not**; Escape closes (hook); `role="alertdialog"`, `aria-modal` |
| `features/extraction/WordEditModal.tsx` | 🔴 | Add vs Edit title from `initialData.id`; typing updates input; Enter and Save fire `onSave(text)`; Cancel/backdrop/Escape fire `onClose`; initial focus on input |
| `components/ErrorBoundary.tsx` | 🔴 | Renders children when healthy; a child throw → fallback UI with `error.message`; Reload button calls `window.location.reload` `(CR:L11)` |
| `components/ProvenanceTable.tsx` | 🔴 | Header+data rows render; trust→bg-class mapping (high green / medium amber / low red); `image_only`→gray + `?` badge; `fuzzy`→`≈` badge `(CR:M14)`; header cells get trust colors (not flat gray); cell/header click → `onCellClick(cell)`; selected cell gets ring + `scrollIntoView`; empty rows → renders nothing |
| `features/export/ExportMenu.tsx` | 🔴 | Toggle open/close; outside mousedown closes; disabled when `rows.length===0`; each text format calls `saveWithDialog` with the matching serializer + `SaveFormat` (mock `exportUtils`); **XLSX calls `saveXlsxWithDialog` with the raw `rows` array (not a serialized string) and never touches `saveWithDialog`** — has tests; Copy writes `toMarkdown` to `navigator.clipboard` (mock) and flips "Copied!" then resets; provenance rows preferred over `savedCsv` |
| `components/DocumentViewer.tsx` | 🔴 | Wheel → zoom clamped `[minScale,4]` with cursor-anchored focal math `(CR:L9)`; pan tool drag updates `transform.x/y`; draw box >5px → `onAddWord` (rounded coords), <5px → no-op; right-click rect → context menu → Edit/Delete fire callbacks; word click → `onWordClick(id)`; hover sets/clears `highlightedWordId`; `getConfidenceColor` hue mapping; `estimateImageDarkness` true/false (mock canvas `getImageData`); imperative `fitToScreen`/`zoomTo`. Mock `ResizeObserver`, `SVGSVGElement.getScreenCTM`, canvas 2d |
| `features/extraction/useDocumentExtraction.ts` | 🔴 | Cache hit → restores pages from DB, no `process_document` call; cache miss → invokes `process_document`, persists pages with UUID ids; `process:progress` event updates `progress` `(CR:M13)`; error → `error` set + guard reset; **`cancel()` invokes `cancel_process_document`; a `CANCELLED_MESSAGE` rejection sets `cancelled` (neutral state, not `error`) and resets the guard so retry re-runs `(CR:M13)`**; `retry()` clears `document_pages` + reprocesses + clears `cancelled` `(CR:M12)`; `addWord`/`editWord`/`deleteWord` update DB + state via **copied** array (no in-place mutation) and bump `sessions.updated_at` `(CR:M12,F10)`; empty-text edit deletes word |
| `features/llama/llamaClient.ts` | 🔴 | `extractTableFromImage` SSE: iterate `logprobs.content[]` (multi-token), missing logprob → `null` not 0 `(CR:M17)`, capture `finish_reason`, per-token char offsets accumulate; **content but zero usable logprobs → a single shape-guard `console.warn` `(CR:F7)`**; `[DONE]`/blank lines skipped; non-OK HTTP throws; `checkLlamaServerHealth` returns true only when `/health` is 200 **and** the body is `{"status":"ok"}` (asserts it's really llama.cpp, not just any 200) `(CR:M8)`; `serverBaseUrl` caches port from `get_llama_server_port`; `startLlamaServer` falls back to `get_setup_paths` when settings paths empty `(CR:F5)`, drops the frontend binary path `(CR:M7)`, rethrows spawn failure. Mock `fetch` with a `ReadableStream`, mock `invoke` |
| `features/llama/LlamaChatContext.tsx` + `useLlamaChat.ts` | 🔴 | `startServer`: returns true on health-200, false + message on `status==='exited'` (fail-fast) `(CR:M10)`, false on 180s timeout; `releaseServer` schedules idle unload, next `startServer` cancels it `(CR:M11)`; watchdog clears ready on health loss; unmount aborts + stops; `requestTableFormat` full pipeline (sanitize→spatial text→extract→parse→match→confidence→persist), `truncated` from `finish_reason:length` `(CR:H7)`, `contextOverflow` from `estimateExtractionBudget` and `maxTokens` clamped to the remaining context `(CR:F3)`, `boostTokens` retry requests the full window, persist bumps `sessions.updated_at` `(CR:F10)`, throws surface to caller `(CR:H8)`, `releaseServer` always runs in `finally`; empty/unparseable output throws |
| `features/setup/useSetupCheck.ts` | 🔴 | `force_setup` flag → incomplete regardless of assets; `check_setup_complete` true→complete; auto-heal writes paths from `get_setup_paths` when complete but `modelPath` empty `(CR:F5)`; invoke throw → incomplete; `requestSetupRerun`/`clearSetupRerun` toggle the flag |

### 6.3 Frontend — pages (Tier 2 component + Tier 4 E2E)

| File | Pri | Component-level (Tier 2) | E2E (Tier 4) |
|---|---|---|---|
| `pages/Dashboard.tsx` | 🔴 | Multi-file → reject message; unsupported MIME → reject; **magic-byte mismatch** (PNG MIME, JPEG bytes) → reject before any DB write `(CR:L6)`; oversize → reject; happy path inserts session+file, navigates; error → `deleteSession` rollback (mock fs/db); drag enter/leave/over state | Real PDF/PNG upload → lands in Session |
| `pages/Session.tsx` | 🔴 | Loads saved CSV/provenance on mount; page input commit + clamp; prev/next disabled at ends; Format-as-Table → `requestTableFormat`; cell click → highlight box (sanitize+`getCellSourceBox`); word click routes raw→select / table→cell; raw/table toggle; **error + truncation + context-overflow banners with Retry; the truncation Retry boosts the token budget (`handleFormatTable(true)`), the others don't (click event never leaks in as the boost flag)** `(CR:H7,H8,F3)`; per-page `error` view + Retry document; **processing spinner shows a Cancel button → `cancel()`; cancelled → neutral state + retry** `(CR:M13)`; editing-modal save → add/edit | Full extract → click cell highlights image → edit word → re-extract → export |
| `pages/Search.tsx` | 🔴 | `formatSqliteTimestamp` UTC→local (and invalid passthrough) `(CR:L4)`; `escapeLike` escapes `% _ \` `(CR:L5)`; debounce (300 ms, fake timers); page clamps when result count shrinks; delete → confirm → `deleteSession` → refresh; empty state text | Search filters; delete removes from list |
| `pages/Settings.tsx` | 🟡 | Theme toggle applies `dark` class + persists; Save paths writes settings; Browse opens dialog (mock); Re-run setup → `requestSetupRerun` | Theme persists across reload; re-run setup shows wizard |
| `pages/About.tsx` | ⚪ | Renders without throwing (smoke) | — |

### 6.4 Frontend — setup wizard steps (Tier 2 + Tier 4)

| File | Pri | Cases |
|---|---|---|
| `features/setup/SetupWizard.tsx` | 🔴 | Step order per mode — automatic skips `config`; progress bar marks done/active; `onError`→ErrorView→"Start over" resets to welcome |
| `features/setup/steps/DownloadStep.tsx` | 🔴 | Manifest fetch → initial per-asset status (installed→`skipped`); sequential `download_file`; **primary fail → `clear_partial_download` + fallback URL** (mock invoke reject then resolve) `(CR:H4)`; extraction overlaps next download (not awaited inline); `setup:progress` events update bars, late event can't regress a terminal status; overall byte-weighted `overallPct`; ETA math (`formatEta`/`formatEtaShort`, rate smoothing, stall keeps last rate); Cancel/Quit confirm → `cancel_setup` + keep progress; window-close interception → confirm dialog `(design §7.4)` |
| `features/setup/steps/ConfigStep.tsx` | 🟡 | Only `available_backends` rendered (no Metal on Windows) `(CR:M6)`; recommended pre-selected, else first option; selecting shows `backendWarning`; Back/Start-download callbacks |
| `features/setup/steps/WelcomeStep.tsx` | 🟡 | Probes hardware (mock `detect_hardware`); Automatic → `onAutomatic(hw)`; Custom → `onCustom(hw)`; loading + probe-failure states |
| `features/setup/steps/CompleteStep.tsx` | 🟡 | Writes `llamaServerPath/modelPath/mmprojPath` from `get_setup_paths`; Launch → `onLaunch` |

### 6.5 Frontend — layout/routing/glue

| File | Pri | Cases |
|---|---|---|
| `App.tsx` | 🟡 | `isLoading`→spinner; `!isComplete`→`SetupWizard`; complete→router; wizard `onComplete` clears force flag + reloads. (Tier 2 with mocked `useSetupCheck`) |
| `layouts/AppLayout.tsx`, `layouts/SplitLayout.tsx` | 🟡 | Split divider drag resizes panes; theme toggle; outlet renders. Mostly E2E |
| `components/SideNavBar.tsx` | 🟡 | Nav links route; active state; session-delete confirm now via the shared `DeleteSessionDialog` (consolidated with Search) `(CR:F12)` — test the dialog once in `features/sessions/DeleteSessionDialog.dom.test.tsx` (confirm → `deleteSession`+`onDeleted`, cancel → `onClose`, closed when `session===null`) |
| `lib/db.ts` | 🔴 | `runMigrations` idempotency: from `user_version` 0 applies v1 and advances; re-run is a no-op; partial-apply re-heals (statements idempotent) `(CR:H1)`; `SESSION_CHILD_TABLES` order. Test against a real `better-sqlite3` in-memory DB or a faithful `Database` stub |
| `features/sessions/sessionActions.ts` | 🔴 | `deleteSession` deletes children in order then parent (no reliance on CASCADE) `(CR:H1)`, emits change, best-effort file removal tolerates missing files (`allSettled`), DB delete precedes FS removal |
| `main.tsx` | ⚪ | Mounts `<ErrorBoundary><App/></ErrorBoundary>` (smoke) |

### 6.6 Rust backend (Tier 3, `cargo test`)

| File | Pri | Unit-testable (pure) | Integration / gated |
|---|---|---|---|
| `setup.rs` | 🔴 | `parse_content_range_total` (valid `bytes 0-9/100`, missing, `*/total`); `accept_unpinned_or_err` (debug Ok / release Err via `cfg`); `hash_file_range` over a temp file; `is_targz`; `find_marker_dir` (nested wrapper); `copy_dir_contents` idempotent re-extract over read-only files `(CR:M16)` | `download_file` via **httpmock**: clean download+verify→rename; resume 206 from `.part` via Range `(CR:M3)`; 416 already-complete hashes from disk; **hash mismatch keeps `.part`, returns Err** `(CR:H4)`; 404/403 returns immediately (no retry); stall → `STREAM_STALL_TIMEOUT` reconnect `(CR:M4)`; `cancel_setup` advances generation → in-flight bails, `.part` kept `(design §7.4)`; `verify_file_hash` async match/mismatch/empty; `extract_archive` zip+tar.gz flatten (synthetic fixtures + existing `PDFIUM_TGZ`); `get_asset_manifest` per backend×platform, `installed` flags, **`version` populated (llama build tag / model revision; `None` for tesseract/pdfium) `(CR:F7)`**; `check_setup_complete` required-set incl. pdfium gating; **`sweep_stale_partials` deletes a `.part` older than the retention window but keeps a fresh one (resume) — assert via mtime on a tempfile `(NC:A2)`** |
| `hardware.rs` | 🔴 | `recommend_backend` full matrix (NVIDIA≥4096→cuda, NVIDIA<4096→cpu, NVIDIA+None→cuda `(CR:H3)`, AMD+linux→rocm, Apple→metal, None→cpu, Intel→cpu); `extract_gpu_vendor` (NVIDIA/AMD/Radeon/Apple/Intel/Unknown); `available_backends` per-OS (`cfg`); `current_os` | `detect_hardware` smoke (returns without panic); nvidia-smi parse — refactor the stdout-parsing into a pure `parse_nvidia_smi(&str)->Option<u64>` to unit-test the saturation-bypass `(CR:H3)` |
| `ocr.rs` | 🔴 | Refactor the scale decision into a pure `upscale_factor(w,h,allow)->f32` (upscale 2.0 when narrow<1500 & allowed, else 1.0) and test it + the box-divide-by-scale coordinate mapping `(design §6.2a)`; `MAX_FILE_SIZE` boundary; extension dispatch (`pdf` vs image vs unknown) | `process_document` per-page fault tolerance (one bad page recorded, rest succeed) `(CR:M13)`; **runs the render/OCR body on `spawn_blocking` (off the async runtime) `(NC:A1)`; `cancel_process_document` bumps the shared `ProcessState` generation `Arc<AtomicU64>` → an in-flight job aborts between pages and returns `CANCELLED_MESSAGE` `(CR:M13)`**; real OCR gated behind `TESSERACT_TEST` with a fixture PNG of known text; `ensure_tesseract_tsv_config` writes the config |
| `llama.rs` | 🟡 | Extract `gpu_layers_for(backend)->&str` (cuda/rocm/metal→999, else 0) as pure + test; PID-file line format parse in `sweep_orphan_server` | `pick_free_port` returns a bindable port; `something_listening` true/false against a temp listener; start/stop lifecycle smoke (spawn a dummy exe), `creation_flags`/log redirect are Windows-manual |
| `paths.rs` | 🟡 | `llama_exe_name`/`tesseract_exe_name`/`pdfium_lib_name` per `cfg`; `pdfium_spec` Some on Win/mac, None elsewhere; `resolve_data_dir` returns `Result` (Err path hard to trigger — covered by callers) `(CR:L8)` | — |
| `export.rs` | 🟡 | `export_xlsx` -- has tests: writes a valid workbook (zip `PK` magic bytes) for a header + data grid; a row/column count past the `u32`/`u16` XLSX limits returns `Err` instead of panicking | — (no network/async; a temp-dir round trip via `std::fs::read` covers it at Tier 3) |
| `lib.rs` | ⚪ | — | Command registry compiles; window-label gating + orphan sweep are E2E/manual |
| `main.rs` | ⚪ | — | entry shim (compile-only) |

### 6.7 Config & non-code

| File | Pri | Validation |
|---|---|---|
| `tauri.conf.json` | 🔴 | Valid JSON; `security.csp` present and blocks inline/eval/external script while allowing `127.0.0.1:*`, asset protocol, Google Fonts, IPC `(CR:L12)` — assert at runtime in E2E (§9) |
| `capabilities/default.json` | 🟡 | No stale `$RESOURCE/binaries/**` shell entries `(CR:M7)`; asset scope matches `sessions/**` |
| `index.html` CSP-affecting `<link>`s | 🟡 | Google Fonts origins match the CSP `font-src`/`style-src` |

---

## 7. End-to-End User Journeys (Tier 4)

Each is a WebdriverIO spec driving the real app via `tauri-driver`. Use fixture documents in `e2e/fixtures/` (a 2-page text PDF, a clean table PNG, a JPEG photo with no table, a corrupt/truncated PDF).

1. **First-run setup — automatic.** Fresh AppData → wizard shows → Automatic → progress bar advances against the fixture asset server → Complete → main app loads. Assert: assets land in AppData, settings written, no console window.
2. **First-run setup — custom + cancel/resume.** Custom → pick backend → start → Cancel mid-download → confirm → `.part` retained → relaunch → resumes and finishes `(design §7.4)`.
3. **Setup fallback.** Primary URL returns 404/bad-hash → wizard clears partial → downloads from fallback → succeeds `(CR:H4)`.
4. **Core extraction loop.** Upload table PNG → "Processing…" → words render → Format as Table → table appears → click a cell → correct box highlights on image → toggle Raw → click a word → cell selects → edit a word → re-extract → values update.
5. **Multi-page PDF.** Upload 2-page PDF → page nav works → per-page extraction independent → one page's table doesn't leak into the other.
6. **Partial-failure tolerance.** Corrupt-page PDF → good pages render, bad page shows per-page error + "Retry document", rest still usable `(CR:M13)`.
7. **Export round-trip.** Extract → Export XLSX/CSV/HTML/MD/TXT (mock save dialog path) → file written (XLSX via the real `export_xlsx` command, since it writes the file itself rather than returning text to the webview); re-import CSV parses back identically (quotes/commas/newlines) `(CR:M1)`.
8. **Persistence.** Extract → reload app → session list shows it → reopen → words, table, provenance, highlights all restored.
9. **Delete + cleanup.** Delete session → rows gone (children + parent) → files removed from disk → no orphans `(CR:H1)`.
10. **Search.** Create sessions → search by title (incl. a title with `%`/`_`) → only literal matches → delete from results.
11. **Settings.** Toggle theme → persists across reload; Re-run setup → wizard reappears.

---

## 8. Crash, Failure & Recovery Matrix ("app crashes" end)

Each row is a deliberately-induced failure with an asserted recovery. Mostly Tier 4 (some Tier 2 where the boundary is mockable).

| Failure injected | Expected behavior | Where tested |
|---|---|---|
| Render-time throw (stale provenance, malformed row) | `ErrorBoundary` fallback + Reload, window never blanks `(CR:H2,L11)` | T2 + T4 |
| User cancels a long PDF mid-processing | `cancel_process_document` → job aborts within one page, neutral "Processing was cancelled" state + "Process document" retry (not a red error) `(CR:M13)` | T2 + T4 |
| llama-server killed mid-extraction (`taskkill`) | Extraction surfaces error + Retry; **next launch reaps the orphan PID** so 3 GB isn't held `(CR:F6)` | T4 + manual |
| llama-server spawns but model GGUF corrupt | `status:exited` → fail-fast within seconds, not a 180 s hang, with a "file may be corrupt / low RAM" message `(CR:M10)` | T2 (mock) + T4 |
| Model load exceeds 60 s on slow disk | Waits up to 180 s, shows "still loading", does not falsely error `(CR:M10)` | T2 (fake timers) |
| Download connection drops mid-stream | Reconnect + resume from `.part`, no restart `(CR:M3)` | T3 |
| Download silently stalls (open socket, no bytes) | Stall timeout → reconnect-resume `(CR:M4)` | T3 |
| Corrupt/truncated download (bad hash) | `.part` kept, never finalized; setup not marked complete; fallback retried `(CR:H4)` | T3 + T4 |
| Mislabeled upload (e.g. `.exe` renamed `.png`) | Rejected at magic-byte check, no session created `(CR:L6)` | T2 + T4 |
| Oversize (>500 MB) upload | Rejected with size message (FE + Rust guards) | T2 + T3 |
| Missing asset at runtime (deleted model/pdfium) | Clear "re-run setup" error, not a panic `(C2,C3,CR:L8)` | T3 + T4 |
| Cleared webview localStorage but assets present | Auto-heal repopulates paths from Rust; app boots normally `(CR:F5)` | T2 + T4 |
| AppData unresolvable | Command returns Err (no `.expect()` panic) `(CR:L8)` | T3 (caller) |
| DB partially-applied migration (crash mid-migrate) | Re-run heals (idempotent DDL), no corruption `(CR:H1)` | T2 (sqlite) |
| Window closed during install | Confirm dialog, progress preserved, not silently discarded `(design §7.4)` | T4 |
| Second window closed (future) | Shared server **not** torn down (label-gated) `(CR:F9)` | T3/manual |

---

## 9. Non-Functional Test Suites (Tier 5, release-gated)

**Accessibility** — `vitest-axe` assertion on every page/dialog render (zero violations), plus manual keyboard-only passes: full setup wizard, full extraction loop, all dialogs (focus trap + Escape per `useDialogA11y` `(CR:L10)`), screen-reader labels on icon-only buttons.

**Performance budgets** (measured in E2E with `performance.now()` / process RSS):
- 100-page text PDF processes without UI freeze; `process:progress` ticks throughout `(CR:M13,H5)`.
- 200-word page: a single word edit re-renders < 100 ms (watch `structuredClone` cost `(CR:F4)`).
- Model load respects the 180 s budget; warm re-extract skips reload `(CR:M11)`.
- Download progress events coalesced ≤ ~10/sec (no UI jank) `(CR:M2)`.
- Big provenance table (50×10) renders and cell-click highlights < 50 ms.

**Security**
- **CSP enforcement** (E2E): injected `<script>` does not execute; `eval` blocked; a `fetch` to an external origin is blocked while `127.0.0.1:<port>` and the asset protocol succeed `(CR:L12)`.
- **Path-injection**: confirm the frontend cannot influence the spawned binary path (resolved in Rust) `(CR:M7)`.
- **SQL injection**: search/title with `%_'"\;` matches literally and cannot break the query `(CR:L5)`.
- No telemetry/outbound calls except R2/HuggingFace during setup and loopback llama traffic (network capture during an extraction).

**Cross-platform matrix** — run Tiers 3–4 on both Windows and macOS runners. Platform-specific asserts: Windows console window suppressed `(CR:M9)`; macOS exec bits preserved on extracted binaries `(CR:H6)`; AppData path `com.aidenpaleczny.anchor` (no `.app`) `(design §7.2)`; pdfium binds to the bundled lib on both `(CR:C3)`.

---

## 10. CI Integration

```
PR (every push):
  - npm ci && npm test (unit+dom) --coverage   # Tiers 1–2, must pass; coverage gate §11
  - npm run lint / tsc --noEmit
  - cargo test (non-gated)                      # Tier 3
  - cargo clippy -- -D warnings, cargo fmt --check
Nightly / pre-release (Win + mac matrix):
  - cargo test with PDFIUM_TGZ + TESSERACT_TEST # gated Rust
  - npm run e2e                                 # Tier 4 journeys + crash matrix
  - axe + performance budgets                   # Tier 5
```

Gated/slow suites never block a PR on the fast feedback loop; they gate the release.

---

## 11. Coverage Targets & Definition of Done

| Layer | Line target | Hard rule |
|---|---|---|
| Pure logic (§6.1) | **95%+** | provenance/confidence/ocrTransforms/export at or near 100% — these are the product |
| Components/hooks (§6.2) | 80%+ | every interactive element has at least one interaction test |
| Rust logic (§6.6) | 85%+ | every `download_file` branch (resume/416/mismatch/404/stall/cancel) covered |
| E2E | journeys, not % | all §7 journeys + all §8 crash rows green on Win+mac |

**A change is "done" when:** new/changed pure logic has unit tests; new UI has a component test for its primary interaction; new Rust branches have a unit or httpmock test; any fixed bug ships with a regression test named after the finding; and the relevant tier passes locally (`npm test`, `cargo test`).

**Authoring order (recommended):** (1) backfill §6.1 gaps — cheapest, highest value; (2) stand up the Tier-2 harness (§4.1) and cover the 🔴 hooks/components; (3) add Tier-3 `download_file`/`hardware`/`ocr` Rust tests; (4) build the Tier-4 journey + crash matrix; (5) wire Tier-5 into release gating.

---

## 12. Fixtures & Test Data

Centralize in `app/src/test/fixtures/` (FE) and `app/src-tauri/tests/fixtures/` (Rust) and `e2e/fixtures/`:
- **OCR words**: small hand-built `OcrWord[]` arrays with known boxes/confidence (reuse the `word()` helper pattern already in `provenance.test.ts`).
- **TSV/logprob pairs**: raw streamed strings with matching `TokenLogprob[]` offsets for confidence tests.
- **Documents**: 2-page text PDF, clean table PNG/JPEG, a no-table photo, a corrupt PDF, a renamed-binary "image".
- **Archives**: tiny synthetic `.zip` and `.tar.gz` with and without wrapper folders for `extract_archive`.
- **Asset server**: a local HTTP fixture serving stand-in tiny "binaries"/"models" with known SHA-256 for the setup E2E (and httpmock responses for Tier 3).
- **DB**: an in-memory SQLite seeded via `MIGRATIONS` for db/session tests.

Keep fixtures small and committed; never depend on the real 2.7 GB model or live R2/HuggingFace in automated tests.
