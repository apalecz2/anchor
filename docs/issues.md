
# Issues

## UI / Frontend

1. Editing the OCR messes up the boxes that are highlighted over the image on the left when you click a cell in the final table on the right

2. Column names are always shown as gray which implies unverified source. Should be green to match their confidence etc. but also show some indication that they are the column names

3. Window size, specifically height messes with the side bar. Squishing the height squishes the side bar items

## Provenance / Matching

1. The columns got messed up. The course column items got split into course and description columns since each has 2 words that seems distinct semantically and positionally. First bit is capitalized name, then numerical course code. Course code is right justified within the course column area (all course code items end before the starting x of the desciption column)
    - Also need a way to mitigate this on the users end -- e.g. chat box to ask LLM to fix this automatically.

2. Everything breaks if the OCR is not perfect. If ocr misses a word, and especially if the missed word is a duplicate of a common word, everything loses alignment.
    - Is the second pass happening?

3. Empty columns ruin matching

4. If the OCR doesn't provide an exact match to the LLM it will say completely unverified. e.g "Calc for eng I" vs "Calc for eng |" leads to the result being unverified even though it was only off by one char. Use XOR distance??? / some sort of fuzzy matching??
    - If it's above some threshold, allow it to be matched but just degrade confidence?

    - Possible addion / solution: create mapping between all cells and OCR, clear out items with clear match, then fuzzy match remaining

### Possible Solutions

- An alternative to the sequence matching could work? Such as an algo that determines x values of columns, y vals of rows to place grid
    - This would allow the links to only be place close to where they're supposed to be based on index in grid?







---

## Resolved

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