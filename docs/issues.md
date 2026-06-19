
# Issues

## UI / Frontend

1. Editing the OCR messes up the boxes that are highlighted over the image on the left when you click a cell in the final table on the right

2. Column names are always shown as gray which implies unverified source. Should be green to match their confidence etc. but also show some indication that they are the column names

3. Window size, specifically height messes with the side bar. Squishing the height squishes the side bar items
    - Resolved

## Provenance / Matching

1. The columns got messed up. The course column items got split into course and description columns since each has 2 words that seems distinct semantically and positionally. First bit is capitalized name, then numerical course code. Course code is right justified within the course column area (all course code items end before the starting x of the desciption column)
    - Also need a way to mitigate this on the users end -- e.g. chat box to ask LLM to fix this automatically.
    - **Root cause / mostly resolved:** the OCR text fed to the LLM (`buildTableText`) spaced each line independently by pixel X, so a wide column with left- and right-justified content (capitalized name + right-justified course code) produced a large within-cell gap that the LLM read as a column break. Fixed by deriving column boundaries once from the header line and snapping every row to them. The user-facing chat-box mitigation is still open.

2. Everything breaks if the OCR is not perfect. If ocr misses a word, and especially if the missed word is a duplicate of a common word, everything loses alignment.
    - Is the second pass happening? -- **Yes now:** a fuzzy second pass (`fuzzyMatchPass`) runs after the exact reading-order walk. Note it only helps *misread* words; a word the OCR *missed entirely* still has no run to match against, so duplicate-value misalignment from a dropped word can remain.
    - **Further mitigated** by the grid cross-check (see #3): cells that *desynced* because of a dropped/duplicate word are now re-placed spatially from the surrounding matched grid, even though the missing word itself still has no run to match.

3. Empty columns ruin matching
    - **Mostly resolved:** a grid cross-check third pass (`gridMatchPass`) now runs after the exact walk + fuzzy pass. For a cell the linear passes left `unmatched` (the failure mode reordered/empty columns produce), it derives the cell's row band from its matched row siblings and its column band from the same column in other rows, then matches only OCR words whose centre falls in that row∩column region. This is exactly the grid approach proposed below. Residual: it needs both a row and a column anchor, so a whole-row or whole-column blackout still can't be triangulated.

### Possible Solutions

- ~~An alternative to the sequence matching could work? Such as an algo that determines x values of columns, y vals of rows to place grid -- This would allow the links to only be placed close to where they're supposed to be based on index in grid?~~
    - **Implemented** as `gridMatchPass` (a cross-check *after* the sequence matcher, not a replacement) — see Provenance #3 above.


## Llama
1. Exiting the app (via ctrl c at least) during image processing does not end the llama server process
2. Llama server sidecar doesn't start in built version 




---

## Resolved

### Provenance / Matching

1. If the OCR doesn't provide an exact match to the LLM it will say completely unverified. e.g "Calc for eng I" vs "Calc for eng |" leads to the result being unverified even though it was only off by one char.

    - Resolved with a fuzzy second pass (`fuzzyMatchPass`). After the exact reading-order walk, each still-unmatched cell is matched against the OCR words bounded by its nearest matched neighbours using normalized Levenshtein similarity (threshold 0.8). Exactly the "clear out items with clear match, then fuzzy match remaining" approach proposed below. Above the threshold the cell is matched but flagged `fuzzy`, its trust is dropped one level, and it shows an `≈` badge instead of the gray "unverified" cell. Bounding the search to the positional gap keeps reading order intact and stops a fuzzy match from stealing a word another cell already owns.

### Parsing

1. Valid commas in the text are not being properly quoted or escaped

    - Moved to TSV which solved this. TSV works fine with LLM without degrading output, and I don't think it's possible to OCR a tab / tabs aren't found in tables, so this works well

2. Anything with valid pipes breaks. OCR said pipe (actual I in image) -- should've been corrected to I in table, but was excluded
    - This was potentially reasoned by the LLM as an acceptable resolution since OCR said | which is stripped before given as context(?) and the item was the "Calc for engineers I" so shortening it to "Calc for engineers" seems valid to the LLM

    - Resolved by allowing pipes that are alone in OCR. e.g "|" allowed but "asd|" gets the pipe removed
    - This still sounds like an issue

### OCR / Preprocessing

1. The preprocessed images still have lines and could probably be improved for the OCR
    -  rule-line removal leaves black smudges/blobs (especially around the boxed memory cells and at line intersections), and the adaptive threshold is creating broken or thickened glyphs

    - Resolved by removing the binarization pipeline entirely, reordering the upscale and letting tesseract binarize, and correcting the tesseract settings. 

```
1. Removed the binarization pipeline entirely.
The old code ran every image through median denoise → adaptive threshold → rule-line removal before handing it to Tesseract. Intermediate debug images showed that Otsu at native 366×259 resolution was cutting through 1–2px antialiased screen font strokes at level ~196 — fragmenting glyphs before any upscaling could help. The remove_rule_lines function was also introducing black smudge artifacts at table line intersections. All of it is gone.

2. Reordered upscale and let Tesseract binarize.
The old code upscaled the already-binary image with nearest-neighbor, which blockified the fragmented pixels. The new pipeline converts to grayscale first, then Lanczos-upscales the grayscale (so antialiased stroke shoulders fatten up), then saves as-is. Tesseract's internal Sauvola/Otsu threshold runs on a 2× larger, smooth image and produces far cleaner glyph boundaries than the hard global cut we were applying to tiny native-resolution pixels.

3. Corrected Tesseract settings.
psm was left at the default (3 = auto-segment), which treats the image as a full page and wastes time on layout analysis. Setting it to 6 (single uniform text block) is the right mode for a screenshot of a table. dpi was defaulting to 150 in rusty-tesseract, which misrepresents post-upscale content and causes Tesseract to miscalibrate its font-size heuristics; setting it to None lets Tesseract estimate from the image itself.
```