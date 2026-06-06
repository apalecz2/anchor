# To-Do

## UI / Frontend

- [ ] Fix: editing OCR words breaks the highlight boxes shown when clicking a cell in the output table
- [ ] Persist `SplitLayout` divider position across navigation — currently resets to 50% every time (`SplitLayout.tsx`)
- [ ] Restrict `ReactMarkdown` to a safe `allowedElements` allowlist — currently renders arbitrary HTML/script from LLM output (`Session.tsx:228`)
- [ ] Add LLM chat box to the output panel so the user can ask the model to fix column structure problems automatically

## Provenance / Matching

- [ ] Fix: column splitting — multi-word column values (e.g. capitalized name + right-justified course code) are being split into separate columns
- [ ] Fix: alignment breaks when OCR misses a word, especially when the missed word is a duplicate of a common value — confirm second pass is running
- [ ] Fix: empty columns ruin matching
- [ ] Measure Stage 2a residual rate on real documents — count `unmatched` cells per document; this decides whether Stage 2b is worth building
- [ ] Investigate grid-based matching as an alternative: infer column x-ranges and row y-ranges from OCR bounding boxes to place provenance links by grid index rather than sequence position
- [ ] Stage 2b (LLM residual provenance) — build only if measured residual warrants it: text-only call for unmatched cells, flat ID-per-cell output, validate range + plausibility

## OCR / Preprocessing

- [ ] Surface Tesseract language limitation in the UI — warn users that only English is supported until multi-language is added (`lib.rs:136`)
- [ ] Smart OCR routing: detect machine-readable PDF text layers and skip Tesseract entirely
- [ ] MIME type validation: verify magic bytes on upload, not just file extension / browser `accept` hint
- [ ] Multi-language OCR: allow users to drop in additional `.traineddata` files; wire language selection to the settings page

## LLM / Extraction

- [ ] Stateful multi-page context: pass column/schema information discovered on page 1 into the prompt when processing page 2+
- [ ] Agentic multi-page workflow for tables that span pages: loop OCR → LLM, detect continuations, merge across page boundaries
- [ ] User-supplied context UI: let the user inject column names, expected formats, or other instructions before extraction begins
- [ ] Unload vision model from RAM after Stage 1 completes to free resources for Stage 2 and the rest of the system

## Export

- [x] Export button and format selector in the Session page output panel
- [x] CSV export (minimum viable — serialize the extracted table)
- [x] HTML export
- [x] Markdown export
- [x] Plain text export
- [x] Copy table option

## Settings

- [ ] Implement the Settings page (currently a placeholder heading only)
- [ ] OCR language selection (currently hardcoded to `"eng"`)
- [ ] Model path configuration (currently resolved at fixed paths)
- [ ] Hardware mode toggle: Low-End (Tesseract + lightweight LLM, no vision) vs. High-End (full vision model)
- [ ] Persisted preference storage for all settings

## Infrastructure / Architecture

- [ ] Background processing queue: make document processing non-blocking so the UI stays responsive during large batches
- [ ] Hardware-adaptive model selection: detect available VRAM/RAM and choose the appropriate model size automatically

## Testing

- [ ] Integration tests for the OCR pipeline
- [ ] Integration tests for database operations
- [ ] Stage 2a duplicate handling: verify that N identical values each map to a distinct, correctly-positioned OCR word (not all to the first one)
- [ ] Cursor desync test: drop an OCR word and confirm a single unmatched cell does not cascade misalignment across the rest of the table

## Roadmap

- [ ] Generative edits: prompt-to-edit workflow ("Change all dates to MM/DD/YYYY") with accept/decline diff UI
- [ ] PDF text overlay: inject a machine-readable text layer over scanned PDFs to make them searchable
- [ ] Mobile companion app: scan on the go and sync to the desktop queue
- [ ] Extensible model interface: allow users to supply their own GGUF models


---

## Out of Scope / Later Additions:
- [ ] XLSX export (requires adding a library dependency)
