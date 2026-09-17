//! Derivation of Stage 1's prompt inputs from OCR words.
//!
//! A port of `app/src/utils/ocrTransforms.ts` (`buildTableText` and the line
//! grouping beneath it) and `sanitizeWordsForProvenance` from
//! `app/src/features/extraction/provenance.ts`.
//!
//! # Why this has to live in Rust
//!
//! The prompt is built from *sanitized* words, and provenance later matches the
//! model's cells against that same word list. Once the executor builds the prompt
//! here, a TypeScript-side derivation would be matching against a different list
//! than the model was actually shown — which doesn't fail loudly, it quietly
//! mismatches cells and drags the confidence heatmap down with it. So the executor
//! derives the words and hands them back in its artifact.
//!
//! # Fidelity rules
//!
//! This must agree with the TypeScript byte for byte, which makes three details
//! load-bearing rather than stylistic:
//!
//! 1. **String lengths are UTF-16 code units.** JavaScript's `String.length`
//!    counts UTF-16 units, and those lengths drive column padding. `"Crédit"` is 6
//!    units but 7 UTF-8 bytes, so measuring in bytes shifts every later column by
//!    one. See [`utf16_len`].
//! 2. **Rounding is JavaScript's.** `Math.round` breaks ties toward +∞, not away
//!    from zero like Rust's `f64::round`. See [`js_round`].
//! 3. **Sorts are stable**, as `Array.prototype.sort` has been since ES2019. Rust's
//!    `sort_by` is stable too, so this holds as long as nobody reaches for
//!    `sort_unstable_by`.
//!
//! The shared fixture in `app/fixtures/` and the golden files beside it are what
//! hold the two implementations together; the tests at the bottom read the very
//! same files the Vitest suite writes.
//!
use crate::ocr::OcrWord;

/// Length in UTF-16 code units — what JavaScript's `String.length` returns.
///
/// Not `len()` (UTF-8 bytes) and not `chars().count()` (scalar values): those agree
/// with JS only for ASCII, and disagree for exactly the accented characters an OCR
/// pass over a real document produces.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `Math.round`: ties go toward +∞ (`-2.5` → `-2`), where Rust's `f64::round` goes
/// away from zero (`-2.5` → `-3`). Pixel anchors are non-negative so the two agree
/// in practice, but relying on that is the kind of assumption that survives right up
/// until coordinates can be negative.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn line_threshold(image_height: f64) -> f64 {
    (image_height * 0.005).max(2.0)
}

/// Cluster words into reading-order lines, then sort each line left-to-right.
///
/// A word opens a new line only when its `top` is more than `threshold` below the
/// *previous* word's top — a gap — rather than below the line's first word. On
/// low-resolution scans the threshold is only a few pixels and a single visual row
/// can drift more than that across its width; anchoring to the first word would
/// exile the drifted word to the next line and silently reorder it relative to its
/// row. See the TypeScript original for the full rationale.
fn group_words_into_lines(words: &[OcrWord], image_height: f64) -> Vec<Vec<&OcrWord>> {
    if words.is_empty() {
        return Vec::new();
    }
    let threshold = line_threshold(image_height);

    let mut by_top: Vec<&OcrWord> = words.iter().collect();
    by_top.sort_by_key(|w| w.box_coords.top);

    let mut lines: Vec<Vec<&OcrWord>> = Vec::new();
    let mut current: Vec<&OcrWord> = vec![by_top[0]];
    let mut prev_top = by_top[0].box_coords.top;

    for word in &by_top[1..] {
        // by_top is ascending, so the gap from the previous word is always >= 0.
        if f64::from(word.box_coords.top - prev_top) > threshold {
            lines.push(current);
            current = vec![word];
        } else {
            current.push(word);
        }
        prev_top = word.box_coords.top;
    }
    lines.push(current);

    for line in lines.iter_mut() {
        line.sort_by_key(|w| w.box_coords.left);
    }
    lines
}

/// The column starts a single line implies: a gap wider than `column_gap` between
/// one word's right edge and the next word's left edge opens a new column, while
/// smaller gaps keep a multi-word heading ("Course Number") in one column.
fn column_anchors_of(line: &[&OcrWord], column_gap: f64) -> Vec<f64> {
    let mut anchors = Vec::new();
    let mut prev_right = f64::NEG_INFINITY;
    for word in line {
        let left = f64::from(word.box_coords.left);
        if left - prev_right > column_gap {
            anchors.push(left);
        }
        prev_right = left + f64::from(word.box_coords.width);
    }
    anchors
}

/// Index of the line whose column starts best describe the whole page.
///
/// Not simply line 0: scanned documents routinely lead with a title or a page
/// number, and a single centred word yields one anchor, collapsing every row into
/// one column. A candidate's anchor is "corroborated" when some other line also
/// starts a word there, so a line scores by how many of its column starts the rest
/// of the page agrees with — a lone title anchor scores at most 1, a four-column
/// header scores 4. Ties go to the earliest line, which keeps a header winning over
/// identically-structured body rows.
fn choose_anchor_line(lines: &[Vec<&OcrWord>], column_gap: f64, tolerance: f64) -> usize {
    let mut best = 0usize;
    let mut best_score: i64 = -1;

    for (index, candidate) in lines.iter().enumerate() {
        let anchors = column_anchors_of(candidate, column_gap);
        let score = anchors
            .iter()
            .filter(|anchor| {
                lines.iter().enumerate().any(|(other_index, other)| {
                    other_index != index
                        && other
                            .iter()
                            .any(|w| (f64::from(w.box_coords.left) - **anchor).abs() <= tolerance)
                })
            })
            .count() as i64;

        if score > best_score {
            best = index;
            best_score = score;
        }
    }
    best
}

/// Reading order: lines top-to-bottom, words left-to-right within each line.
fn sort_words(words: &[OcrWord], image_height: f64) -> Vec<&OcrWord> {
    group_words_into_lines(words, image_height)
        .into_iter()
        .flatten()
        .collect()
}

/// Sort words into reading order, strip column-rule pipe glyphs, drop empties.
///
/// Words whose *entire* text is pipe glyphs (an OCR misread of "I" as "|") are kept
/// with their original text so the model can still cross-reference the image; they
/// go unmatched by provenance and surface as an "unverified source" badge rather
/// than being silently dropped.
pub fn sanitize_words_for_provenance(words: &[OcrWord], natural_height: i32) -> Vec<OcrWord> {
    sort_words(words, f64::from(natural_height))
        .into_iter()
        .filter_map(|word| {
            let stripped = word.text.trim_matches('|').trim();
            let text = if stripped.is_empty() {
                word.text.clone()
            } else {
                stripped.to_owned()
            };
            if text.is_empty() {
                None
            } else {
                Some(OcrWord {
                    // Carried through, never regenerated: the frontend's stored
                    // provenance references these ids.
                    id: word.id.clone(),
                    text,
                    confidence: word.confidence,
                    box_coords: word.box_coords,
                })
            }
        })
        .collect()
}

/// Rebuild spatially-accurate text from the structured words array.
///
/// Column boundaries are derived once from a single representative line and every
/// row is snapped to them. Real columns are vertically consistent across rows,
/// whereas a wide cell holding left- and right-justified content is not — so
/// pinning each row to one line's columns stops that within-cell gap being mistaken
/// for a column break (which previously spawned a phantom trailing column).
pub fn build_table_text(words: &[OcrWord], natural_height: i32) -> String {
    if words.is_empty() {
        return String::new();
    }

    // Derive a pixels-per-character scale from the word boxes themselves.
    let mut total_px = 0.0f64;
    let mut total_chars = 0.0f64;
    for word in words {
        if utf16_len(&word.text) > 0 && word.box_coords.width > 0 {
            total_px += f64::from(word.box_coords.width);
            total_chars += utf16_len(&word.text) as f64;
        }
    }
    let avg_char_width = if total_chars > 0.0 {
        total_px / total_chars
    } else {
        8.0
    };

    let lines = group_words_into_lines(words, f64::from(natural_height));

    // A gap wider than ~3 characters between a line's words starts a new column;
    // smaller gaps keep multi-word headers together. The corroboration tolerance is
    // one character: scanned columns align to within a character, not to the pixel.
    let column_gap = avg_char_width * 3.0;
    let header_index = choose_anchor_line(&lines, column_gap, avg_char_width);
    let mut anchors = column_anchors_of(&lines[header_index], column_gap);
    if anchors.is_empty() {
        anchors.push(f64::from(lines[header_index][0].box_coords.left));
    }

    // The column a word belongs to: the rightmost anchor at or left of the word. A
    // word between two anchors (right-justified content in a wide cell) maps to the
    // left column rather than spilling into the next one.
    let column_of = |left: f64| -> usize {
        let mut col = 0usize;
        for (c, anchor) in anchors.iter().enumerate().skip(1) {
            if left + avg_char_width * 0.5 >= *anchor {
                col = c;
            } else {
                break;
            }
        }
        col
    };

    let rendered: Vec<String> = lines
        .iter()
        .map(|line| {
            // Bucket words into header columns, joining intra-column words with a space.
            let mut cells: Vec<String> = vec![String::new(); anchors.len()];
            for word in line {
                let c = column_of(f64::from(word.box_coords.left));
                if cells[c].is_empty() {
                    cells[c] = word.text.clone();
                } else {
                    cells[c].push(' ');
                    cells[c].push_str(&word.text);
                }
            }

            // Render cells padded to each column's character anchor. Lengths are
            // tracked in UTF-16 units to match the JavaScript this mirrors.
            let mut result = String::new();
            let mut result_len = 0usize;
            for c in 0..anchors.len() {
                if cells[c].is_empty() {
                    continue;
                }
                let target_col = js_round(anchors[c] / avg_char_width).max(0.0) as usize;
                if target_col > result_len {
                    let pad = target_col - result_len;
                    result.push_str(&" ".repeat(pad));
                    result_len += pad;
                } else if result_len > 0 {
                    result.push(' ');
                    result_len += 1;
                }
                result.push_str(&cells[c]);
                result_len += utf16_len(&cells[c]);
            }
            result
        })
        .collect();

    rendered.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::BoundingBox;
    use serde::Deserialize;

    // The same fixture and golden files the Vitest suite writes
    // (`app/src/utils/promptEquivalence.test.ts`). Compiled in, so a missing or
    // renamed fixture is a build error rather than a silently skipped test.
    const FIXTURE_JSON: &str = include_str!("../../../fixtures/ocr-page.json");
    const GOLDEN_SPATIAL: &str = include_str!("../../../fixtures/ocr-page.spatial.txt");
    const GOLDEN_SANITIZED: &str = include_str!("../../../fixtures/ocr-page.sanitized.txt");

    #[derive(Deserialize)]
    struct Fixture {
        #[serde(rename = "naturalHeight")]
        natural_height: i32,
        words: Vec<OcrWord>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE_JSON).expect("fixture must parse")
    }

    /// Git may check the golden files out with CRLF endings; the comparison is about
    /// content, not the checkout's line-ending policy.
    fn normalize(s: &str) -> String {
        s.replace("\r\n", "\n").trim_end().to_owned()
    }

    fn word(text: &str, left: i32, top: i32, width: i32) -> OcrWord {
        OcrWord {
            id: None,
            text: text.to_owned(),
            confidence: 90.0,
            box_coords: BoundingBox {
                left,
                top,
                width,
                height: 20,
            },
        }
    }

    // ---- the cross-language contract ----

    /// The real Stage 1 composition: sanitize first, then lay out. Chained in the
    /// same order as the frontend, because laying out raw words would leave pipe
    /// glyphs in the prompt and shift the columns.
    fn spatial_text_of(f: &Fixture) -> String {
        let sanitized = sanitize_words_for_provenance(&f.words, f.natural_height);
        build_table_text(&sanitized, f.natural_height)
    }

    #[test]
    fn spatial_layout_matches_the_typescript_golden() {
        let f = fixture();
        assert_eq!(normalize(&spatial_text_of(&f)), normalize(GOLDEN_SPATIAL));
    }

    #[test]
    fn sanitized_words_match_the_typescript_golden() {
        let f = fixture();
        let rendered = sanitize_words_for_provenance(&f.words, f.natural_height)
            .iter()
            .map(|w| format!("{}\t{}\t{}", w.text, w.box_coords.left, w.box_coords.top))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(normalize(&rendered), normalize(GOLDEN_SANITIZED));
    }

    /// The trap that motivates [`utf16_len`]: if column padding were measured in
    /// UTF-8 bytes, every column after an accented cell would shift left by one.
    /// Asserted directly so the cause is named, not just caught by the golden file.
    #[test]
    fn non_ascii_cells_pad_by_utf16_length_not_bytes() {
        assert_eq!(utf16_len("Crédit"), 6);
        assert_eq!("Crédit".len(), 7, "UTF-8 bytes, which must NOT be used");

        let f = fixture();
        let spatial = spatial_text_of(&f);
        let header = spatial.lines().nth(1).expect("header line");
        let grade_col = header.find("Grade").expect("Grade column");
        let credit_col = header.find("Crédit").expect("Crédit column");
        // `find` returns a byte offset, so measure the gap in characters instead.
        let gap = header[credit_col..grade_col].chars().count();
        assert_eq!(
            gap,
            utf16_len("Crédit") + 8,
            "padding must follow UTF-16 units"
        );
    }

    // ---- the pieces, independently ----

    #[test]
    fn js_round_breaks_ties_toward_positive_infinity() {
        assert_eq!(js_round(2.4), 2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0, "Rust's f64::round would give -3");
        assert_eq!(js_round(-2.6), -3.0);
    }

    #[test]
    fn line_threshold_has_a_two_pixel_floor() {
        assert_eq!(line_threshold(1000.0), 5.0);
        assert_eq!(line_threshold(100.0), 2.0, "0.5px would split every word");
        assert_eq!(line_threshold(0.0), 2.0);
    }

    #[test]
    fn words_group_into_lines_by_gap_to_the_previous_word() {
        let words = vec![
            word("a", 0, 100, 10),
            word("b", 20, 103, 10), // +3: within the 5px threshold
            word("c", 40, 106, 10), // +3 again: still the same line, cumulatively +6
            word("d", 0, 200, 10),  // a real row break
        ];
        let lines = group_words_into_lines(&words, 1000.0);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0].len(),
            3,
            "a line may drift further than the threshold"
        );
        assert_eq!(lines[1].len(), 1);
    }

    #[test]
    fn each_line_is_sorted_left_to_right() {
        let words = vec![word("z", 300, 100, 10), word("a", 10, 100, 10)];
        let lines = group_words_into_lines(&words, 1000.0);
        assert_eq!(
            lines[0].iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            vec!["a", "z"]
        );
    }

    /// A centred title yields one uncorroborated anchor; the header below it yields
    /// several that the body rows agree with. Picking the title would collapse the
    /// whole page into a single column.
    #[test]
    fn anchor_line_is_the_corroborated_one_not_the_first() {
        let words = vec![
            word("TITLE", 400, 10, 50),
            word("Name", 20, 100, 40),
            word("Score", 300, 100, 50),
            word("Ann", 20, 200, 30),
            word("99", 300, 200, 20),
        ];
        let lines = group_words_into_lines(&words, 1000.0);
        let avg = 10.0;
        assert_eq!(choose_anchor_line(&lines, avg * 3.0, avg), 1);
    }

    #[test]
    fn empty_input_produces_empty_output() {
        assert_eq!(build_table_text(&[], 1000), "");
        assert!(sanitize_words_for_provenance(&[], 1000).is_empty());
    }

    #[test]
    fn pipe_glyphs_are_stripped_only_when_they_wrap_real_text() {
        let words = vec![
            word("|Calc|", 0, 100, 60),
            word("||", 100, 100, 20),
            word("Fine", 200, 100, 40),
        ];
        let out = sanitize_words_for_provenance(&words, 1000);
        let texts: Vec<&str> = out.iter().map(|w| w.text.as_str()).collect();
        // An all-pipe word survives with its original text so the model can still
        // resolve it against the image.
        assert_eq!(texts, vec!["Calc", "||", "Fine"]);
    }

    /// Word ids must survive sanitizing unchanged. The frontend stores these ids in
    /// each cell's provenance, so a regenerated id would break click-to-highlight the
    /// next time the session is opened — silently, and only after a reload.
    #[test]
    fn sanitize_carries_word_ids_through_unchanged() {
        let mut words = vec![word("|Calc|", 0, 100, 60), word("Fine", 200, 100, 40)];
        words[0].id = Some("w-alpha".into());
        words[1].id = Some("w-beta".into());

        let out = sanitize_words_for_provenance(&words, 1000);
        assert_eq!(out[0].text, "Calc", "text is sanitized");
        assert_eq!(out[0].id.as_deref(), Some("w-alpha"), "id is not");
        assert_eq!(out[1].id.as_deref(), Some("w-beta"));
    }

    #[test]
    fn sanitize_returns_words_in_reading_order() {
        let words = vec![
            word("second", 300, 100, 60),
            word("third", 0, 200, 50),
            word("first", 10, 100, 50),
        ];
        let out = sanitize_words_for_provenance(&words, 1000);
        let texts: Vec<&str> = out.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, vec!["first", "second", "third"]);
    }

    /// Words with zero width contribute no pixels *and* no characters to the scale,
    /// so a page made entirely of them falls back to the 8px default rather than
    /// dividing by zero.
    #[test]
    fn zero_width_words_do_not_divide_by_zero() {
        let words = vec![word("x", 0, 100, 0), word("y", 50, 100, 0)];
        let text = build_table_text(&words, 1000);
        assert!(text.contains('x') && text.contains('y'));
    }
}
