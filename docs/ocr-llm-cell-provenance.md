# Cell-Level Provenance & Confidence for OCR + LLM Table Extraction

Implementation reference for showing, per CSV cell, (a) how confident the system is and (b) where in the source image the value came from — running a small local vision model (Qwen3.5-4B class) at ~10 tokens/sec on standard work-grade hardware.

This document is the complete spec. It assumes the implementer (Claude Code) has access to the existing codebase but no prior context on this feature.

---

## 1. Problem & Constraints

### What we're building
A document/table extractor with this pipeline:
1. **OCR** (Tesseract) reads the image → words, bounding-box positions, per-word confidence.
2. OCR output is formatted as context and handed to a **small local vision LLM** (Qwen3.5-4B, via llama.cpp's OpenAI-compatible `/v1/chat/completions`).
3. The **image is the source of truth**; OCR is backup for ambiguous glyphs and is authoritative for *positioning*.
4. The LLM emits structured table data.

We must surface, for every output cell:
- **Provenance** — which OCR word(s) / image region the cell value came from, so the UI can highlight the source on the image when a cell is clicked.
- **Confidence** — a combined OCR + LLM signal, plus a disagreement flag, so a human knows which cells to verify.

### Hard constraints (these drive every design decision)
- **~10 tokens/sec decode.** Output tokens are the dominant latency cost. Every token in the model's output is ~100ms of wall-clock time. A 200-token response is 20 seconds. **Minimizing output tokens is the primary objective.**
- **Small model.** A 4B model is not reliable at free-form structured output. It will hallucinate, drift format, and emit invalid references unless constrained. We use **GBNF grammar-constrained decoding** to make malformed output structurally impossible.
- **Local / standard hardware.** No cloud fallback. Must degrade gracefully, never hang, never require a large token budget.

### Why pipe format, not JSON
JSON's per-cell scaffolding (`{"value":"...","source":[...]}`) costs ~5–8× the output tokens of the raw value. At 10 t/s that multiplier is the difference between a 10s and a 60s response. The compact pipe format below carries the same information (value + source word ID) at roughly **1 extra token per cell**.

---

## 2. Output Format Specification

### The format
The model outputs **one line per table row**. Within a row, **cells are tab-separated**. Within a cell, the value and its source reference are **pipe-separated**:

```
<value>|<wordId>\t<value>|<wordId>\t...\n
```

Concrete example. Source table:

| Invoice No | Date       | Amount |
|------------|------------|--------|
| INV-001    | 2024-01-15 | 1250   |
| INV-002    | 2024-01-16 | 980    |

Model output (header emitted as the first row — see §2.3):
```
Invoice No|0	Date|2	Amount|3
INV-001|12	2024-01-15|13	1250|14
INV-002|15	2024-01-16|16	980|17
```

### 2.1 Field semantics
- **`value`** — the cell's text content, exactly as it should appear in the final CSV. The model may correct OCR errors here using the image (image is source of truth).
- **`wordId`** — an integer ID referencing the OCR word the value primarily came from. This is the provenance link. Rules:
  - If the value maps to a single OCR word → that word's ID.
  - If it spans multiple OCR words → the ID of the **first** word (we expand to the full span during validation using positions; see §6).
  - If the value was read from the **image only** (no usable OCR word — OCR missed it or garbled it beyond matching) → the sentinel **`-1`**. This is the critical case the old char-offset string-matching approach could not represent.

### 2.2 Why this is cheap
- A bare value in CSV is 1–4 tokens. Adding `|14` is typically **1 token for the pipe+digits** for small IDs (tokenizers often merge `|` with short digit runs, and even when not, it's 2 tokens). Tab and newline are 1 token each, same as CSV.
- No repeated keys, no braces, no always-on quotes. The only escaping is `\|` on the rare value that contains a literal pipe (see §2.4).
- Net overhead vs raw CSV: **~1 token/cell.** For a 10×5 table that's ~50 extra tokens (~5 seconds at 10 t/s). Acceptable; JSON would have added 400+.

### 2.3 Header handling — emit the first row, label it in code
The app receives a bare image and must *discover* the table structure, including which row is the header. The model does not know the column names ahead of time any more reliably than it knows the data — it's reading the header off the image like everything else. So the model emits **every row it sees, including the header row**, as ordinary rows in the pipe format. Our code then **treats the first emitted row as the header** during post-processing and reattaches it as the CSV header.

- The header cells get `wordId` provenance and confidence like any other cell — a small bonus (you can highlight where a column name came from too).
- The model's job stays uniform: "emit every row." No conditional "is this a header?" decision, which a small model would get wrong.
- Cost is one extra row of output — negligible, and you genuinely need that data.

Do **not** ask the model to *mark* which row is the header (e.g. a flag column). That adds tokens and invites the small model to mislabel. First-row-is-header in code is more reliable.

**Future multipage case (not needed now):** when a table spans pages and you already have column names from a previous page, that is the one situation where you'd pass a known schema in the prompt and suppress the header row to save the tokens. Out of scope for the current single-image flow.

### 2.4 Delimiters and the pipe-in-value case
The delimiters are tab (between cells), newline (between rows), and pipe (between value and `wordId`).

**Tab and newline are safe.** Tesseract's word-level output (`image_to_data`) emits one entry per contiguous non-whitespace glyph run, so a single OCR word cannot contain a tab or newline. Even when a cell value joins multiple OCR words (e.g. `John Smith`), the only internal character introduced is a space — never a tab or newline. So tab/newline as delimiters are sound with no escaping needed.

**Pipes can occur in real values**, so the value/`wordId` separator needs escaping rather than a forbidden-character rule. We escape, we do **not** quote:

- A literal pipe inside a value is emitted as `\|` (backslash-pipe).
- A literal backslash is emitted as `\\`.
- The real separator is a single **unescaped** pipe.

Why escaping and not quoting: quoting only the cells that contain a pipe is *conditional* formatting, and small models are unreliable at conditional structure (they quote when they shouldn't, forget when they should) — and the grammar to express "quote iff the value contains a pipe" is awkward. Always-quoting every value avoids the conditional but costs ~2 tokens per cell across the entire table to handle a rare case, which is the wrong trade at 10 t/s. Escaping is a simple, non-conditional local rule ("a literal pipe is always written `\|`") that the model can follow reliably, and it costs an extra token only on the rare cells that actually contain a pipe. The grammar (§4) expresses it as a regular language, so it stays clean.

> **Do not switch to exotic delimiters** (e.g. `\x1f`/`\x1e` control chars) to dodge pipes. A 4B model has seen pipes, tabs, and backslashes constantly in training (CSV, markdown, code) and has strong priors about them as structure; it has essentially never seen ASCII unit/record separators. Forcing it to emit characters it has no prior over makes cell-boundary decisions *worse* even though the grammar keeps output syntactically valid. Stick with pipe + escaping.

---

## 3. OCR Context Construction (input to the model)

The model needs to see the OCR words *with their IDs* so it can reference them. This is input (prefill) cost, paid once, not decode cost — but keep it lean anyway because prefill still takes time and eats context.

### Format the OCR as an indexed word list
Assign each OCR word a stable integer ID (its index in your OCR word array). Provide them to the model in reading order, grouped by line, compact:

```
OCR words (id:"text"@conf):
0:"Invoice"@96 1:"No"@95 2:"Date"@93 3:"Amount"@90
12:"INV-001"@94 13:"2024-01-15"@88 14:"1250"@71
15:"INV-002"@92 16:"2024-01-16"@90 17:"980"@45
```

- `id` — integer, matches the `wordId` the model will emit.
- `text` — the OCR'd string.
- `conf` — Tesseract confidence 0–100. Including it helps the model decide when to trust OCR vs. override from the image. It costs input tokens; if prefill becomes a bottleneck you can drop `@conf` (the model still has the image), but keeping it measurably improves the model's override decisions.

### Keep IDs small
Small integer IDs tokenize cheaply both in the prompt and in the output. Don't use UUIDs or coordinate tuples as IDs. The ID is purely an index into your own OCR array, which holds the real bounding boxes.

### Positions stay out of the prompt
Do **not** put bounding-box coordinates in the prompt — they're expensive and the model doesn't need them to emit a `wordId`. Your code already holds `ocrWords[id].bbox`. Provenance highlighting (§7) is done entirely in code by looking up the bbox for the returned ID.

---

## 4. GBNF Grammar

llama.cpp constrains generation to this grammar via the `grammar` field on the completion request (or `--grammar-file`). This makes the pipe format **structurally guaranteed** — the 4B model cannot emit prose, markdown fences, JSON, or malformed rows. (The header row *is* emitted, as an ordinary first row — see §2.3.)

### 4.1 Grammar (fixed column count known ahead of time)
If you know the table has exactly N columns, hard-code the structure — this is the tightest, most reliable grammar. Example for **3 columns**:

```gbnf
root        ::= row (nl row)* nl?
row         ::= cell tab cell tab cell
cell        ::= value "|" wordid
value       ::= vchar+
vchar       ::= [^\t\n\\|] | "\\|" | "\\\\"
wordid      ::= "-1" | [0-9]+
tab         ::= "\t"
nl          ::= "\n"
```

### 4.2 Grammar (variable column count)
If column count varies per document, allow ≥1 cell per row:

```gbnf
root        ::= row (nl row)* nl?
row         ::= cell (tab cell)*
cell        ::= value "|" wordid
value       ::= vchar+
vchar       ::= [^\t\n\\|] | "\\|" | "\\\\"
wordid      ::= "-1" | [0-9]+
tab         ::= "\t"
nl          ::= "\n"
```

Prefer 4.1 when you can. Fixing the column count stops the model from emitting too few/too many cells per row — a common small-model failure that the variable grammar permits.

### 4.3 Notes on the grammar
- `vchar ::= [^\t\n\\|] | "\\|" | "\\\\"` — a value character is anything except tab/newline/backslash/pipe, **or** an escaped pipe `\|`, **or** an escaped backslash `\\`. This lets values contain literal pipes (written `\|`) while keeping a single unescaped pipe as the value/`wordId` separator. The parser unescapes after splitting (§6.1).
- `wordid` permits `-1` (image-only sentinel) or any non-negative integer. It does **not** bound the integer to your actual ID range — GBNF can't easily express "0 to N". Range validation happens in code (§6). If you want grammar-level bounding for a known small N, you can enumerate (e.g. for max id 17: tedious but possible); not worth it — code validation is simpler and cheaper.
- The trailing `nl?` allows but doesn't require a final newline.
- The model emits the header row as an ordinary row (§2.3); first-row-is-header is applied in post-processing, not enforced by the grammar.

### 4.4 Bounding output length
Grammar doesn't limit length. Also set `max_tokens` defensively based on expected table size:
```
max_tokens ≈ estimatedRows × estimatedCols × 8   (8 = generous per-cell token budget)
```
For a 20×5 table: ~800 tokens. At 10 t/s that's an 80s worst case — see §9 for row-chunking to bound this on large tables.

---

## 5. Request Construction (llama.cpp `/v1/chat/completions`)

### 5.1 Request body
```typescript
type TableExtractionRequest = {
    model: string;
    messages: ChatCompletionMessage[];   // system + user(image + OCR context)
    max_tokens: number;                   // computed per §4.4
    temperature: 0;                       // deterministic extraction; no creativity wanted
    stream: true;
    grammar: string;                      // the GBNF from §4
    logprobs: true;                       // for LLM confidence — see §8
    top_logprobs: 0;                      // we only need the chosen-token logprob; 0 keeps it cheap
};
```

Notes:
- **`temperature: 0`** — extraction is not a creative task. Greedy decoding is more reliable and reproducible. (Grammar + temp 0 is the most deterministic configuration.)
- **`grammar`** — pass the GBNF string. In llama.cpp's server this is the `grammar` field. (If using a build that only supports `json_schema`/`grammar` via a different field name, check the server version; `grammar` is standard on recent llama.cpp.)
- **`top_logprobs: 0`** — we score confidence from the *selected* token's logprob only. We don't need alternatives, so don't pay for them.
- **`logprobs: true`** does not add output tokens or decode time — it's metadata on tokens already generated. Free confidence.

### 5.2 The image
Send the image per the model's vision input convention (base64 image content block in the user message). The full-resolution image is the source of truth. If you row-chunk (§9), send the cropped band instead.

### 5.3 System prompt (keep short — it's prefill)
```
Extract the table as rows. One line per row, tab-separated cells.
Each cell: VALUE|WORDID
VALUE = the correct text (use the image; fix OCR errors). Write a literal pipe inside a value as \|.
WORDID = the id of the OCR word it came from, or -1 if not in the OCR list.
Include the header row as the first row. Output only rows. No commentary.
```
The grammar enforces the format regardless, but the prompt aligns the model's intent so it spends its constrained choices well (e.g. picking the *right* word ID, deciding when to use -1, including the header row as the first row).

---

## 6. Parsing & Validation

After streaming completes you have the raw pipe-format string. Parse and validate before trusting any reference.

### 6.1 Parse
```typescript
type RawCell = { value: string; wordId: number };

// Find the last UNescaped pipe — the value/wordId separator.
// A pipe is escaped iff it's preceded by an odd number of backslashes.
function lastUnescapedPipe(s: string): number {
    for (let i = s.length - 1; i >= 0; i--) {
        if (s[i] !== "|") continue;
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
        if (backslashes % 2 === 0) return i;   // even (incl. 0) → unescaped → this is the separator
    }
    return -1;
}

// Reverse the escaping applied to values: \| → |   and   \\ → \
function unescapeValue(s: string): string {
    return s.replace(/\\([\\|])/g, "$1");
}

function parsePipeFormat(output: string): RawCell[][] {
    return output
        .split("\n")
        .filter(line => line.length > 0)
        .map(line =>
            line.split("\t").map(cellStr => {
                const sep = lastUnescapedPipe(cellStr);
                const value = unescapeValue(cellStr.slice(0, sep));
                const wordId = parseInt(cellStr.slice(sep + 1), 10);
                return { value, wordId };
            })
        );
}
```

Note the split order: split rows on `\n` and cells on `\t` first (the grammar guarantees those never appear inside a value, so a plain split is safe), then within each cell find the separator with `lastUnescapedPipe` and unescape. Do **not** use a plain `lastIndexOf("|")` — a value may legitimately end in an escaped pipe `\|`, and `lastIndexOf` would split on it and corrupt both the value and the `wordId`.

### 6.2 Validate each reference (critical — the model is small and will lie)
For every `wordId` that isn't `-1`:
1. **Range check** — `0 <= wordId < ocrWords.length`. If out of range → treat as `-1` (image-only), flag as `invalid_ref`.
2. **Plausibility check** — compare the cell `value` against `ocrWords[wordId].text`. Normalize both (lowercase, strip punctuation/whitespace) and compute similarity (e.g. normalized Levenshtein or a simple containment check). If they're wildly different, the model referenced the wrong word → flag as `ref_mismatch`. Keep the value (image is truth) but mark provenance as low-trust.

```typescript
type ValidatedCell = {
    value: string;
    wordId: number | null;          // null = image-only or invalid
    refStatus: "ok" | "image_only" | "invalid_ref" | "ref_mismatch";
};
```

This validation layer is **not optional**. A 4B model emitting confident-but-wrong word IDs is the single biggest correctness risk in this feature. Catching it here is what makes the provenance trustworthy.

### 6.3 Expand multi-word spans (for highlighting)
When a value covers multiple OCR words (e.g. value `John Smith` referencing word `John`), find adjacent OCR words on the same line whose concatenation matches the value, and collect all their IDs for the bounding-box union (§7). This is a position-based expansion using `ocrWords[id].bbox`, done in code, not by the model.

---

## 7. Provenance UI (image highlighting)

Once each cell has its validated `wordId`(s), highlighting is pure geometry — no model involvement.

```typescript
function getCellSourceBox(cell: ValidatedCell, ocrWords: OcrWord[]): BBox | null {
    if (cell.wordId === null) return null;        // image-only: nothing to box, show "image-derived" badge
    const ids = cell.spanWordIds ?? [cell.wordId]; // from §6.3 expansion
    return unionBoxes(ids.map(id => ocrWords[id].bbox));
}
```

UI behavior:
- **Click a CSV cell** → look up its source box → draw an overlay rectangle on the displayed image.
- **`image_only` cells** → no box; show a small "read from image" badge so the user knows OCR didn't back this value (these warrant a closer look).
- **`ref_mismatch` cells** → draw the box but in a warning color; the model claimed this source but the text doesn't match.

`OcrWord.bbox` comes from Tesseract directly (`left, top, width, height` per word). Scale to the displayed image dimensions.

---

## 8. Confidence Scoring

Three independent signals per cell. Don't collapse them prematurely — they answer different questions.

### 8.1 LLM confidence (from logprobs)
Map each output token's logprob to the cell it belongs to. Because output is streamed token-by-token, track a running character offset exactly as in the original design, then assign tokens to the cell whose `value` span contains that offset. (Pipe and delimiter tokens are ignored — only tokens inside a `value` count.)

```typescript
// probability of a token = Math.exp(logprob)
// per cell:
const llmConfidence = cellValueTokens.length > 0
    ? Math.exp(meanLogprob(cellValueTokens))   // geometric mean of token probabilities
    : 0;
const llmMinTokenProb = Math.min(...cellValueTokens.map(t => Math.exp(t.logprob)));
```

Report **both** the geometric mean and the **minimum** token probability. The minimum catches the "one wrong digit in an otherwise confident number" case that the mean hides — often the most useful flag for tabular numeric data.

> Note: geometric mean penalizes longer multi-token cells (more tokens, more chances for a low one). The min-token metric partly compensates. For very long cells, lean on min rather than mean.

### 8.2 OCR confidence
For cells with a valid `wordId`, OCR confidence is the mean Tesseract confidence of the mapped word(s):
```typescript
const ocrConfidence = cell.wordId === null
    ? null
    : mean(spanWordIds.map(id => ocrWords[id].confidence)); // 0–100
```
`null` for `image_only` cells — there is no OCR measurement, so don't fabricate one.

### 8.3 Agreement / disagreement (the strongest signal)
Whether the LLM's value matches the OCR word it points to is a more direct correctness signal than either confidence alone:
```typescript
const agreement =
    cell.refStatus === "image_only" ? "image_only" :
    cell.refStatus === "ref_mismatch" ? "disagree" :
    normalizedEqual(cell.value, ocrWords[cell.wordId].text) ? "agree" : "disagree";
```

### 8.4 Combining into a display state
Don't reduce to one blended number when signals conflict. Use a small state machine — it's more honest and more actionable for the human verifier:

```typescript
function cellTrust(cell): "high" | "medium" | "low" {
    if (cell.agreement === "disagree") return "low";        // OCR and LLM disagree → always verify
    if (cell.agreement === "image_only") {
        return cell.llmConfidence >= 0.85 ? "medium" : "low"; // no OCR backup; trust the model only if very confident
    }
    // agree: blend, weighted toward OCR (direct measurement of legibility)
    const blended = 0.4 * cell.llmConfidence + 0.6 * (cell.ocrConfidence / 100);
    if (blended >= 0.85 && cell.llmMinTokenProb >= 0.5) return "high";
    if (blended >= 0.65) return "medium";
    return "low";
}
```

Color mapping for the UI: `high → green`, `medium → yellow`, `low → red`.

Rationale for the weighting and gates:
- **0.6 toward OCR** when they agree: OCR confidence is a direct measurement of image legibility; LLM logprobs conflate legibility with formatting tokens, rare words, and abbreviation ambiguity.
- **`llmMinTokenProb >= 0.5` gate on "high"**: prevents a cell with one shaky token from being marked green on the strength of its average.
- **Disagreement overrides everything**: two independent readers producing different text is the highest-value thing to surface, regardless of how confident either was.
- All thresholds should be config constants. The values above are reasonable starting points for a 4B model; tune empirically against a labeled sample.

---

## 9. Performance Engineering for 10 t/s

Everything here exists to keep **output tokens** down, since that's the binding constraint.

### Output token budget, summarized
| Source | Cost |
|---|---|
| Cell value | unavoidable (1–4 tok) |
| `\|wordId` provenance | ~1 tok/cell |
| Tab/newline delimiters | 1 tok each (same as CSV) |
| Header row | 1 row, emitted as data (§2.3) — needed, not waste |
| Pipe-escaping `\|` | +1 tok only on cells containing a literal pipe (§2.4) |
| JSON scaffolding | **0 — not used** |
| Commentary/prose | **0 — grammar forbids it (§4)** |

The grammar's biggest performance contribution is eliminating the model's ability to waste tokens on anything that isn't a cell.

### Row-chunking for large tables
For tables beyond ~15–20 rows, don't extract in one call:
1. Use OCR word positions to find row y-bands.
2. Crop the image to a band of N rows; send only the OCR words in that band (re-indexed or with original IDs preserved).
3. Extract that chunk; repeat.

Benefits: bounded `max_tokens` per call (no runaway), cheaper prefill per call (smaller image, fewer OCR words), and **better small-model accuracy** because it attends to less at once. Downside: more round-trips. Net win for large tables at 10 t/s because it caps worst-case latency and prevents max_tokens truncation mid-table.

### Delimiter selection
Tab/newline/pipe were chosen because they tokenize as single tokens, rarely appear in tabular values, and (crucially) the model has strong learned priors about them as structural characters. Tab and newline cannot appear inside a value (§2.4), so they need no escaping. Pipes can appear in values and are handled by escaping (`\|`), not by swapping delimiters. **Do not switch to exotic control-char delimiters** to avoid pipes — see the warning in §2.4: a 4B model has essentially no prior over `\x1f`/`\x1e`, so forcing them degrades cell-boundary decisions even with the grammar holding format valid. The escape approach keeps the cheap, well-understood delimiters and pays a token only on the rare pipe-bearing cell.

### What NOT to do
- Don't request `top_logprobs > 0` unless you actually display alternatives — it's wasted metadata.
- Don't raise temperature — temp 0 is faster to reason about and more reproducible; there's no quality upside for extraction.
- Don't emit positions/bboxes in the output — they're in your OCR array already; making the model repeat them is pure token waste.

---

## 10. End-to-End Flow Summary

```
Image
  │
  ├─► Tesseract OCR ──► ocrWords[]: { id, text, confidence, bbox }
  │                          │
  │                          └─► format indexed word list (§3)  ─┐
  │                                                              │
  └──────────────────────────────────────────────────► [image] ─┤
                                                                 ▼
                                          llama.cpp /v1/chat/completions
                                          (system prompt §5.3 + image + OCR list,
                                           grammar §4, temp 0, logprobs, stream)
                                                                 │
                                                                 ▼
                                          pipe-format stream:  VALUE|ID\tVALUE|ID\n
                                          + per-token logprobs (tracked by char offset)
                                                                 │
                          ┌──────────────────────────────────────┤
                          ▼                                       ▼
                  parsePipeFormat (§6.1)                  map logprobs→cells (§8.1)
                          │                                       │
                          ▼                                       │
                  validateRefs (§6.2):                            │
                    range + plausibility                          │
                          │                                       │
                          ▼                                       ▼
                  ValidatedCell[][]  +  llmConfidence, llmMinTokenProb,
                                        ocrConfidence, agreement
                          │
                          ▼
                  cellTrust state machine (§8.4)  → green/yellow/red
                  span expansion (§6.3)           → source bbox (§7)
                          │
                          ▼
                  CSV (reattach header §2.3)  +  per-cell trust color
                                              +  click-to-highlight-on-image
```

---

## 11. Implementation Checklist (for Claude Code)

- [x] Extend the llama client request type with `grammar`, `logprobs: true`, `top_logprobs: 0`, `temperature: 0`.
- [x] Build the GBNF grammar string (fixed-column variant §4.1 if column count known; else §4.2). Make column count a parameter.
- [x] Build the indexed OCR word-list formatter (§3) — IDs = array indices, include `@conf`.
- [x] Write the short system prompt (§5.3).
- [x] In the streaming loop: collect per-token logprobs with cumulative char offsets (existing pattern from the original design).
- [x] `parsePipeFormat` (§6.1) — including `lastUnescapedPipe` separator detection and `unescapeValue` (`\|`→`|`, `\\`→`\`).
- [x] Take the first parsed row as the header; reattach it when emitting the final CSV (§2.3). Remaining rows are data.
- [x] `validateRefs`: range check + normalized plausibility check; assign `refStatus` (§6.2).
- [x] Span expansion for multi-word cells (§6.3).
- [x] `mapLogprobsToCells` adapted to pipe format — assign value-span tokens only, compute geometric mean + min token prob (§8.1).
- [x] OCR confidence aggregation per cell, `null` for image-only (§8.2).
- [x] Agreement classification (§8.3) and `cellTrust` state machine (§8.4) with config-constant thresholds.
- [x] `getCellSourceBox` + UI overlay; badges for `image_only` and `ref_mismatch` (§7).
- [x] `max_tokens` computed from estimated table size (§4.4).
- [x] Row-chunking path for large tables (§9) — can be a follow-up if initial tables are small.
- [x] Confirm tab/newline/pipe tokenize as single tokens in the Qwen3.5 tokenizer, and that `\|` doesn't tokenize pathologically (§9). No exotic-delimiter swap.

---

## 12. Testing Notes

- **Validate the grammar first, in isolation.** Send a known image, confirm output is always parseable pipe format with no prose or markdown fences (the header *is* expected as the first row). If the model fights the grammar (stalls, empty output), the grammar likely has an error — test it with llama.cpp's `--grammar-file` on a plain completion before wiring it in.
- **Stress the reference accuracy, not the format.** The format is guaranteed by the grammar; the risk is wrong `wordId`s. Build a small labeled set where you know the correct word→cell mapping and measure how often the model's IDs are right. This number decides whether model-asserted provenance is worth keeping vs. falling back to position-based char-offset matching.
- **Test the image-only path explicitly.** Feed an image where OCR misses a cell (low-contrast region) and confirm the model emits `-1` and the cell is flagged `image_only` rather than getting a bogus ID.
- **Measure real output token counts** on representative tables and confirm latency at 10 t/s is acceptable before optimizing further. Decide the row-chunking threshold from these measurements.
