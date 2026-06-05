# Implementation Status: Cell-Level Provenance & Confidence

Reference spec: `docs/ocr-llm-cell-provenance.md`
Date: 2026-06-05

---

## Summary

All 16 checklist items from the spec have corresponding **library code** written and exported. None of that code has been **wired into the actual extraction flow** yet. The app still runs the old pipeline (plain-text OCR excerpt → free-form LLM prompt → raw CSV string). The new pipeline exists as a complete, tested library sitting alongside the old one, waiting to be connected.

---

## What Is Implemented (the library)

### `app/src/features/llama/llamaClient.ts`
| What | Status |
|---|---|
| `grammar?`, `logprobs?`, `top_logprobs?` added to `ChatCompletionRequestBody` | ✅ Done |
| `TokenLogprob` type exported (`token`, `logprob`, `charOffset`) | ✅ Done |
| Streaming loop collects per-token logprobs with cumulative `charOffset` | ✅ Done |
| `streamChatCompletion` returns `tokenLogprobs: TokenLogprob[]` in its result | ✅ Done |

### `app/src/features/llama/promptUtils.ts`
| What | Status |
|---|---|
| `buildGbnfGrammar(columnCount?)` — fixed §4.1 or variable §4.2 variant | ✅ Done |
| `TABLE_EXTRACTION_SYSTEM_PROMPT` — exact short prompt from §5.3 | ✅ Done |
| `computeMaxTokens(rows, cols)` — rows × cols × 8 with floor of 64 | ✅ Done |

### `app/src/utils/ocrTransforms.ts`
| What | Status |
|---|---|
| `formatIndexedOcrWordList(words, imageHeight)` — indexed `id:"text"@conf` format §3 | ✅ Done |
| `formatIndexedOcrWordSubset(words, indices, imageHeight)` — for chunked calls with preserved IDs | ✅ Done |
| `getRowBands(words, imageHeight)` — one `RowBand` per text line | ✅ Done |
| `chunkRowBands(bands, chunkSize)` — splits into groups of N rows | ✅ Done |
| `mergeRowBands(bands)` — union y-extent for image cropping | ✅ Done |
| `getWordIndicesInBand(words, band)` — original indices preserved | ✅ Done |
| `CHUNK_ROW_THRESHOLD = 15`, `CHUNK_SIZE = 10` constants | ✅ Done |

### `app/src/features/extraction/pipeFormat.ts` (new file)
| What | Status |
|---|---|
| `lastUnescapedPipe`, `unescapeValue`, `parsePipeFormat` — §6.1 | ✅ Done |
| `splitHeaderAndData` — first row as header §2.3 | ✅ Done |
| `rawCellsToCSV` — RFC 4180 CSV emission with header reattached | ✅ Done |
| `validateRefs` — range check + containment plausibility; `refStatus` §6.2 | ✅ Done |
| `expandSpans` — adjacent word span expansion for multi-word cells §6.3 | ✅ Done |
| `mapLogprobsToCells` — geometric mean + min token prob per cell §8.1 | ✅ Done |
| `aggregateOcrConfidence` — mean Tesseract conf per cell, `null` for image-only §8.2 | ✅ Done |
| `classifyAgreement` — §8.3 | ✅ Done |
| `cellTrust` state machine — §8.4 | ✅ Done |
| `TRUST_THRESHOLDS` config constants (all four thresholds named) | ✅ Done |
| `getCellSourceBox` + `unionBoxes` — §7 provenance geometry | ✅ Done |

### `app/src/features/extraction/CellProvenance.tsx` (new file)
| What | Status |
|---|---|
| `ProvenanceRect` — SVG `<rect>` for click-to-highlight; dashed amber for `ref_mismatch` | ✅ Done |
| `CellProvenanceBadge` — inline HTML badge for `image_only` / `ref_mismatch` | ✅ Done |

### `app/src/components/DocumentViewer.tsx`
| What | Status |
|---|---|
| `provenanceOverlay?: React.ReactNode` prop; rendered inside SVG above OCR rects | ✅ Done |

### `app/scripts/verify-tokenizer.mjs`
| What | Status |
|---|---|
| Tokenizer verification script against `/tokenize` endpoint | ✅ Done, verified |
| Confirmed: tab=1, newline=1, pipe=1, `\|`=2 tokens. Digit-per-token for IDs. No exotic delimiter needed. | ✅ Confirmed |

---

## What Is Not Wired Up

### 1. No `streamTableExtraction` function exists

The spec (§5) describes a distinct request — with `grammar`, `logprobs: true`, `top_logprobs: 0`, `temperature: 0`, and `TABLE_EXTRACTION_SYSTEM_PROMPT`. This request body has **never been assembled and fired**. There is no function (in `llamaClient.ts`, `useLlamaChat.ts`, or anywhere else) that:

- Sets `temperature: 0`
- Sets `grammar: buildGbnfGrammar(columnCount)`
- Sets `logprobs: true, top_logprobs: 0`
- Uses `TABLE_EXTRACTION_SYSTEM_PROMPT` as the system message
- Computes `max_tokens` via `computeMaxTokens`
- Formats OCR words via `formatIndexedOcrWordList` instead of `buildOcrExcerpt`
- Returns both the raw content string **and** `tokenLogprobs` to the caller

This is the single most important missing piece. Everything else flows from it.

### 2. `useLlamaChat.requestTableFormat` still uses the old pipeline

`app/src/features/llama/useLlamaChat.ts:15` — `requestTableFormat` currently:

- Formats OCR with `buildOcrExcerpt(ocrText, 80, 5000)` — the old plain-text approach
- Constructs a prompt asking for raw CSV (no pipe format, no word IDs)
- Calls `context.sendMessage()`, which goes through `LlamaChatContext` using `streamChatCompletion` with `temperature: 0.7`, no grammar, no logprobs
- Stores the raw string response directly as `csv_content` in the database

None of the new library functions are called here.

### 3. `LlamaChatContext.sendMessage` discards `tokenLogprobs`

`app/src/features/llama/LlamaChatContext.tsx:230` — `sendMessage` calls `streamChatCompletion` and returns only `finalAssistantMessage.content`, discarding the `tokenLogprobs` array that the streaming loop now collects. Even if the new grammar request were fired through this path, the logprob data would be lost before `mapLogprobsToCells` could use it.

### 4. Post-processing pipeline is never called

After a response arrives, none of the following are called anywhere:

```
parsePipeFormat → splitHeaderAndData → validateRefs → expandSpans
                                                ↓
                              mapLogprobsToCells + aggregateOcrConfidence
                                                ↓
                              classifyAgreement + cellTrust
                                                ↓
                              rawCellsToCSV + getCellSourceBox
```

The library functions exist and are correct in isolation, but there is no orchestrating function that chains them in the right order.

### 5. `Session.tsx` has no provenance UI wiring

`app/src/pages/Session.tsx` — the session page currently:

- Passes `provenanceOverlay={undefined}` to `DocumentViewer` (prop exists but is never set)
- Has no state for `selectedCell: ValidatedCell | null`
- Has no click handler on the CSV table that would trigger a highlight
- Renders the CSV output as a plain `<table>` (via `parseCSV`), with no per-cell trust color
- Does not import or use `CellProvenanceBadge`, `ProvenanceRect`, `getCellSourceBox`, or any `pipeFormat` function

### 6. Trust colors are not surfaced anywhere

`cellTrust` returns `"high" | "medium" | "low"`. The spec maps these to green/yellow/red. No component currently reads these values and applies color to table cells. The trust state machine is implemented but produces output that nothing consumes.

### 7. `sortWords` must be called before `formatIndexedOcrWordList`

`formatIndexedOcrWordList` documents that its input must be pre-sorted in reading order. The caller (the future `streamTableExtraction`) must call `sortWords(words, imageHeight)` first. This is not enforced by the type system and will silently produce wrong IDs if skipped.

### 8. Two parallel ID systems coexist without a bridge

The existing OCR word highlight system (`highlightedWordId: string | null` in `Session.tsx`) uses `OcrWord.id` — a string UUID assigned by the Tauri backend. The new provenance system uses **array indices** (integers) as word IDs. These are different namespaces. When click-to-highlight is wired up, the Session page will need to look up `ocrWords[wordId]` (by array index) and then decide how to correlate with the existing `highlightedWordId` string-based system, or replace it for the provenance use case.

### 9. The `Dashboard.tsx` "Start Llama Server" button is a loose end

`app/src/pages/Dashboard.tsx` has a bare `<button onClick={async () => await startLlamaServer()}>` added directly. This bypasses `LlamaChatContext`'s server lifecycle management (health polling, watchdog, `isServerStarting` state). It will start the server process but the context won't know it's up. This button should either be removed or moved into a component that goes through `context.startServer()`.

---

## What Needs to Be Built Next

In priority order:

### A. `streamTableExtraction` function (critical path)

A new function in `llamaClient.ts` (or a new file) that assembles the full §5.1 request:

```typescript
export const streamTableExtraction = async ({
    imageBase64,
    imageType,
    ocrWords,          // pre-sorted OcrWord[]
    imageHeight,
    columnCount?,      // undefined → variable grammar
    signal?,
}: TableExtractionOptions): Promise<TableExtractionResult> => {
    const grammar = buildGbnfGrammar(columnCount);
    const ocrWordList = formatIndexedOcrWordList(ocrWords, imageHeight);
    const maxTokens = computeMaxTokens(
        estimatedRows,   // derive from getRowBands length
        columnCount ?? estimatedCols
    );
    // fire streamChatCompletion with temperature:0, grammar, logprobs:true, top_logprobs:0
    // return { rawOutput, tokenLogprobs }
};
```

### B. Post-processing orchestrator

A function (or hook) that chains the library in the right order:

```typescript
parsePipeFormat(rawOutput)
  → validateRefs(rows, ocrWords)
  → expandSpans(validated, ocrWords, imageHeight)
  → mapLogprobsToCells(rawOutput, tokenLogprobs, rawRows)
  → aggregateOcrConfidence(validated, ocrWords)
  → classifyAgreement + cellTrust per cell
  → rawCellsToCSV([header, ...data])
```

### C. `useLlamaChat.requestTableFormat` replacement

Replace the old OCR-excerpt + free-form-CSV path with calls to `streamTableExtraction` + the post-processing chain. Store the parsed `ValidatedCell[][]` and per-cell trust levels (not just the CSV string) so the UI can use them.

### D. Session.tsx provenance UI

- Add `selectedCell: { row: number; col: number } | null` state
- On CSV table cell click: call `getCellSourceBox(validatedRows[row][col], ocrWords)` and set `provenanceOverlay={<ProvenanceRect box={box} refStatus={...} />}`
- Apply trust-level background color to each `<td>` (green/yellow/red)
- Render `<CellProvenanceBadge refStatus={...} />` inside cells with `image_only` or `ref_mismatch` status

### E. Fix the Dashboard.tsx server button

Remove the orphan button or route it through `LlamaChatContext.startServer()`.

---

## Known Design Notes

- **`\|` = 2 tokens, not 1** — The spec estimated "|wordId" adds ~1 token/cell. Verified for Qwen3.5: each digit is a separate token, so `|12` = 3 tokens. The `TOKENS_PER_CELL = 8` budget in `computeMaxTokens` absorbs this correctly. No format change needed.
- **`\t\n` merges to 1 token** in Qwen3.5 — harmless since they appear separately in real output.
- **`OcrWord.id` is a string UUID** (from Tesseract/backend), distinct from the integer array-index IDs used in the provenance system. Both must coexist during the transition.
- **`expandSpans`** uses a rightward-only search from the anchor word. Left-expansion is not attempted. If the model habitually picks a middle word as anchor, this will miss spans. Worth monitoring once the pipeline runs end-to-end.
- **`classifyAgreement` maps `invalid_ref` to `"image_only"`** — no valid OCR word to compare, so treated as no-OCR-backing. This is consistent with `wordId: null` on those cells.
