//! Parsing Surya-OCR-2's two grounding outputs.
//!
//! Surya answers in two shapes, and the P0 spike (`prototypes/Surya/table-grid-test.mjs`)
//! established which one to believe:
//!
//! - **`table` mode** returns `[{label: "Row"|"Col", bbox}]` — the row and column
//!   *bands* whose intersections are the table's cells. On the sample transcript this
//!   came back as 13 × 6 well-formed bands, with the columns forming a perfect
//!   contiguous tiling. This is the structural source of truth.
//! - **`ocr` mode** returns `<div data-label data-bbox>` blocks with a `<table>` riding
//!   along inside one of them. Its *text* is useful; its *geometry* is not — the whole
//!   transcript came back as a single `Table` block, and its own column count
//!   disagreed with the bands (it collapsed `BUSINESS | 1299E` under one header and
//!   dropped a value). So the HTML supplies cell text and the bands supply structure.
//!
//! # Why the parsing is here and not in TypeScript
//!
//! Two rules from the plan meet in this file.
//!
//! 1. **Convert coordinates at the seam.** Surya reports every box normalized to
//!    0–1000 per axis; `DocumentViewer` draws raw pixels into a natural-size viewBox.
//!    Converting here means exactly one coordinate space crosses the bridge and
//!    reaches provenance, confidence and the overlay.
//! 2. **Char offsets are UTF-16 code units**, the same space `TokenLogprob::char_offset`
//!    uses, so the grounder's own logprobs can be mapped onto the text it produced —
//!    which is what gives a model-grounded item a confidence number at all. Rust's
//!    native byte offsets would silently misalign on the first accented character.
//!
//! # Status
//!
//! Inert. No catalog preset grounds on a model yet, so nothing calls this at runtime;
//! it is built and tested ahead of the preset that will (P5) so the grounding
//! machinery can be verified against fixtures rather than against a half-working
//! pipeline.

use serde::Serialize;

use crate::ocr::BoundingBox;

/// Surya normalizes every coordinate to this range, per axis, regardless of the
/// page's real pixel size.
const NORM_SCALE: f64 = 1000.0;

/// A box in Surya's normalized space: `x0 y0 x1 y1`, each 0–1000.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormBox {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

/// An inclusive 1-D interval in *page pixels* — a row band's y-extent or a column
/// band's x-extent. Mirrors the `Span` type `provenance.ts` already matches within.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Span {
    pub lo: f64,
    pub hi: f64,
}

/// The grid a grounding model reported directly, in page pixels.
///
/// This is the payload that lets provenance skip `detectColumnSeparators` and the
/// gap-based line clustering beneath it — the inference that every Provenance/Matching
/// post-mortem in `docs/issues.md` is about.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredGrid {
    pub row_bands: Vec<Span>,
    pub col_bands: Vec<Span>,
}

/// One `<div data-label data-bbox>` block from `ocr` mode.
#[derive(Debug, Clone, PartialEq)]
pub struct SuryaBlock {
    pub label: String,
    /// `None` when the attribute was missing or not four finite numbers. A block
    /// without geometry is still returned — its text may be all we get — rather than
    /// dropped, so a partial answer degrades instead of vanishing.
    pub bbox: Option<NormBox>,
    /// Tags stripped, entities decoded, whitespace collapsed.
    pub text: String,
    /// The block's inner HTML verbatim. A `<table>` lives *inside* a block rather
    /// than being a block itself, so this is where table markup survives.
    pub inner_html: String,
    /// UTF-16 offsets of `inner_html` within the raw output — the same coordinate
    /// space as `TokenLogprob::char_offset`.
    pub char_start: usize,
    pub char_end: usize,
}

/// Row and column bands from `table` mode, in Surya's normalized space.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Bands {
    /// Sorted top-to-bottom.
    pub rows: Vec<NormBox>,
    /// Sorted left-to-right.
    pub cols: Vec<NormBox>,
    /// Entries that named no recognizable label or carried no usable bbox. Kept
    /// rather than silently dropped so a caller can tell "the model returned nothing"
    /// from "the model returned something we could not read".
    pub rejected: usize,
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/// Convert a normalized box to page pixels, clamped to the page.
///
/// Rounding is `f64::round` rather than the JavaScript tie-break [`crate::pipeline::prompt`]
/// needs: these boxes have no TypeScript counterpart to stay byte-identical with, and
/// a half-pixel on a 2000px page is not a meaningful difference.
pub fn to_pixel_box(b: &NormBox, width: f64, height: f64) -> BoundingBox {
    let sx = width / NORM_SCALE;
    let sy = height / NORM_SCALE;
    let left = (b.x0.min(b.x1) * sx).clamp(0.0, width);
    let right = (b.x0.max(b.x1) * sx).clamp(0.0, width);
    let top = (b.y0.min(b.y1) * sy).clamp(0.0, height);
    let bottom = (b.y0.max(b.y1) * sy).clamp(0.0, height);
    BoundingBox {
        left: left.round() as i32,
        top: top.round() as i32,
        width: (right - left).round() as i32,
        height: (bottom - top).round() as i32,
    }
}

/// Build the declared grid from `table` mode's bands.
///
/// Returns `None` when the bands cannot describe a table: a grid is only worth having
/// if it has at least one row and **two** columns, since a single-column table has no
/// horizontal structure to exploit (the same bar `detectTableGrid` applies before
/// inferring one).
///
/// Degenerate and out-of-range bands are dropped rather than failing the whole grid —
/// the P0 run produced none, but a model that emits one bad band should cost us that
/// band, not the page. Overlapping bands are *kept*: a word is assigned to the first
/// band containing its center, which is deterministic, and rejecting overlaps outright
/// would throw away an otherwise usable grid over one sloppy edge.
pub fn declared_grid(bands: &Bands, width: f64, height: f64) -> Option<DeclaredGrid> {
    let span = |lo: f64, hi: f64, scale: f64, limit: f64| -> Option<Span> {
        let (lo, hi) = (lo.min(hi), lo.max(hi));
        if !lo.is_finite() || !hi.is_finite() || hi <= lo {
            return None;
        }
        if hi < 0.0 || lo > NORM_SCALE {
            return None;
        }
        Some(Span {
            lo: (lo * scale).clamp(0.0, limit),
            hi: (hi * scale).clamp(0.0, limit),
        })
    };

    let mut row_bands: Vec<Span> = bands
        .rows
        .iter()
        .filter_map(|b| span(b.y0, b.y1, height / NORM_SCALE, height))
        .collect();
    let mut col_bands: Vec<Span> = bands
        .cols
        .iter()
        .filter_map(|b| span(b.x0, b.x1, width / NORM_SCALE, width))
        .collect();

    if row_bands.is_empty() || col_bands.len() < 2 {
        return None;
    }

    row_bands.sort_by(|a, b| a.lo.total_cmp(&b.lo));
    col_bands.sort_by(|a, b| a.lo.total_cmp(&b.lo));
    Some(DeclaredGrid {
        row_bands,
        col_bands,
    })
}

// ---------------------------------------------------------------------------
// `table` mode — Row/Col bands as JSON
// ---------------------------------------------------------------------------

/// Pull the JSON array out of a model response that may be fenced, prefaced, or
/// wrapped in an object.
///
/// Deliberately tolerant. The model is prompted for a bare array, but a stray
/// ```` ```json ```` fence or a `{"bands": [...]}` wrapper is a formatting slip, not a
/// failed extraction, and losing the whole page's structure to one is not a trade
/// worth making.
fn extract_json_array(raw: &str) -> Option<Vec<serde_json::Value>> {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("```") {
        // Drop an opening fence plus its optional language tag, and the closing one.
        let rest = rest.split_once('\n').map(|(_, body)| body).unwrap_or(rest);
        s = rest.trim_end().strip_suffix("```").unwrap_or(rest).trim();
    }

    let parsed = serde_json::from_str::<serde_json::Value>(s)
        .ok()
        .or_else(|| {
            let start = s.find('[')?;
            let end = s.rfind(']')?;
            if end <= start {
                return None;
            }
            serde_json::from_str::<serde_json::Value>(&s[start..=end]).ok()
        })?;

    match parsed {
        serde_json::Value::Array(entries) => Some(entries),
        serde_json::Value::Object(map) => map.into_iter().find_map(|(_, v)| match v {
            serde_json::Value::Array(entries) => Some(entries),
            _ => None,
        }),
        _ => None,
    }
}

/// Read a bbox that may arrive as `[x0, y0, x1, y1]` or as the string `"x0 y0 x1 y1"`.
fn to_norm_box(value: Option<&serde_json::Value>) -> Option<NormBox> {
    let nums: Vec<f64> = match value? {
        serde_json::Value::Array(items) => items.iter().filter_map(|v| v.as_f64()).collect(),
        serde_json::Value::String(s) => s
            .split([' ', ',', '\t'])
            .filter(|p| !p.is_empty())
            .filter_map(|p| p.parse::<f64>().ok())
            .collect(),
        _ => return None,
    };
    if nums.len() != 4 || !nums.iter().all(|n| n.is_finite()) {
        return None;
    }
    Some(NormBox {
        x0: nums[0],
        y0: nums[1],
        x1: nums[2],
        y1: nums[3],
    })
}

/// Parse `table` mode's output into row and column bands.
pub fn parse_bands(raw: &str) -> Bands {
    let mut bands = Bands::default();
    let Some(entries) = extract_json_array(raw) else {
        return bands;
    };

    for entry in entries {
        let label = entry
            .get("label")
            .or_else(|| entry.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let bbox = to_norm_box(entry.get("bbox").or_else(|| entry.get("box")));

        match (bbox, label.as_str()) {
            (Some(b), l) if l.starts_with("row") => bands.rows.push(b),
            (Some(b), l) if l.starts_with("col") => bands.cols.push(b),
            _ => bands.rejected += 1,
        }
    }

    // Reading order: rows top-to-bottom, columns left-to-right.
    bands.rows.sort_by(|a, b| a.y0.total_cmp(&b.y0));
    bands.cols.sort_by(|a, b| a.x0.total_cmp(&b.x0));
    bands
}

// ---------------------------------------------------------------------------
// `ocr` mode — HTML blocks, with offsets
// ---------------------------------------------------------------------------

/// UTF-16 offset of a byte index — what `String.length` would count up to there.
///
/// Linear in the prefix, and called once per block boundary. A page carries tens of
/// blocks, so the quadratic term is irrelevant beside being obviously correct.
fn utf16_offset(raw: &str, byte_index: usize) -> usize {
    raw[..byte_index].encode_utf16().count()
}

/// Whether the byte after `<div` ends the tag name, so `<divider>` is not a `<div>`.
fn ends_tag_name(b: Option<&u8>) -> bool {
    matches!(b, Some(c) if c.is_ascii_whitespace() || *c == b'>' || *c == b'/') || b.is_none()
}

/// Split `ocr` mode's HTML into top-level blocks.
///
/// Depth-aware rather than regex-per-div so a block whose content nests a `<div>` (a
/// list group) is not split in half. Stray closing tags are tolerated: a truncated
/// response should yield the blocks it did finish, not nothing.
pub fn parse_blocks(raw: &str) -> Vec<SuryaBlock> {
    // `to_ascii_lowercase` maps only A–Z, so byte indices stay aligned with `raw`.
    let lower = raw.to_ascii_lowercase();
    let lb = lower.as_bytes();

    let mut blocks = Vec::new();
    let mut depth: usize = 0;
    let mut open_attrs: &str = "";
    let mut content_start: usize = 0;
    let mut i = 0usize;

    let tag_end = |from: usize| -> Option<usize> {
        lb[from..].iter().position(|&b| b == b'>').map(|p| from + p)
    };

    while i < lb.len() {
        if lb[i] != b'<' {
            i += 1;
            continue;
        }
        if lb[i..].starts_with(b"</div") && ends_tag_name(lb.get(i + 5)) {
            let Some(gt) = tag_end(i) else { break };
            if depth > 0 {
                depth -= 1;
                if depth == 0 {
                    blocks.push(make_block(open_attrs, raw, content_start, i));
                }
            }
            i = gt + 1;
            continue;
        }
        if lb[i..].starts_with(b"<div") && ends_tag_name(lb.get(i + 4)) {
            let Some(gt) = tag_end(i) else { break };
            if depth == 0 {
                open_attrs = &raw[i + 4..gt];
                content_start = gt + 1;
            }
            depth += 1;
            i = gt + 1;
            continue;
        }
        i += 1;
    }

    blocks
}

fn make_block(attrs: &str, raw: &str, content_start: usize, content_end: usize) -> SuryaBlock {
    let inner = &raw[content_start..content_end];
    SuryaBlock {
        label: attribute(attrs, "data-label").unwrap_or_default(),
        bbox: attribute(attrs, "data-bbox")
            .and_then(|v| to_norm_box(Some(&serde_json::Value::String(v)))),
        text: strip_tags(inner),
        inner_html: inner.trim().to_owned(),
        char_start: utf16_offset(raw, content_start),
        char_end: utf16_offset(raw, content_end),
    }
}

/// Read `name="value"` (or `name='value'`) out of a tag's attribute text.
fn attribute(attrs: &str, name: &str) -> Option<String> {
    let lower = attrs.to_ascii_lowercase();
    let at = lower.find(name)?;
    let rest = &attrs[at + name.len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &rest[quote.len_utf8()..];
    let end = body.find(quote)?;
    Some(body[..end].to_owned())
}

/// Plain text of an HTML fragment: tags removed, the five XML entities decoded,
/// whitespace collapsed.
///
/// A tag is replaced by a **space**, not by nothing: `<td>A</td><td>B</td>` is two
/// cells, and eliding the boundary would run them together into `AB`, which is neither
/// what the page says nor something provenance can match.
///
/// Entity decoding is not cosmetic either — provenance matches this text against the
/// table's cells, and a literal `&amp;` where the page shows `&` is a mismatch.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        // Ampersand last, so "&amp;lt;" decodes to "&lt;" rather than "<".
        .replace("&amp;", "&");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // The column bands the P0 spike actually recorded for `sample_invoice.png`:
    // a perfect contiguous tiling of the table width. Used as the realistic case
    // rather than round numbers, so the tests exercise the shape the model emits.
    const P0_COLS: [(f64, f64); 6] = [
        (12.0, 111.0),
        (111.0, 212.0),
        (212.0, 651.0),
        (651.0, 811.0),
        (811.0, 910.0),
        (910.0, 977.0),
    ];

    fn col(x0: f64, x1: f64) -> NormBox {
        NormBox {
            x0,
            y0: 0.0,
            x1,
            y1: 1000.0,
        }
    }

    fn row(y0: f64, y1: f64) -> NormBox {
        NormBox {
            x0: 0.0,
            y0,
            x1: 1000.0,
            y1,
        }
    }

    // ---- coordinates ----

    #[test]
    fn normalized_boxes_convert_to_page_pixels() {
        let b = NormBox {
            x0: 0.0,
            y0: 0.0,
            x1: 500.0,
            y1: 250.0,
        };
        let px = to_pixel_box(&b, 2000.0, 1000.0);
        assert_eq!(px.left, 0);
        assert_eq!(px.top, 0);
        assert_eq!(px.width, 1000);
        assert_eq!(px.height, 250);
    }

    /// A model that emits `x1 < x0` has described the same rectangle backwards, not a
    /// negative-width one. Normalizing here keeps every downstream consumer — which
    /// all assume `width >= 0` — honest.
    #[test]
    fn an_inverted_box_is_normalized_rather_than_producing_negative_extents() {
        let px = to_pixel_box(
            &NormBox {
                x0: 800.0,
                y0: 600.0,
                x1: 200.0,
                y1: 100.0,
            },
            1000.0,
            1000.0,
        );
        assert_eq!((px.left, px.width), (200, 600));
        assert_eq!((px.top, px.height), (100, 500));
    }

    #[test]
    fn boxes_are_clamped_to_the_page() {
        let px = to_pixel_box(
            &NormBox {
                x0: -50.0,
                y0: 0.0,
                x1: 1200.0,
                y1: 1000.0,
            },
            1000.0,
            500.0,
        );
        assert_eq!(px.left, 0);
        assert_eq!(px.width, 1000);
        assert_eq!(px.height, 500);
    }

    // ---- declared grid ----

    #[test]
    fn the_p0_bands_produce_a_usable_grid() {
        let bands = Bands {
            rows: (0..13)
                .map(|i| row(i as f64 * 70.0, i as f64 * 70.0 + 60.0))
                .collect(),
            cols: P0_COLS.iter().map(|&(a, b)| col(a, b)).collect(),
            rejected: 0,
        };
        let grid = declared_grid(&bands, 1000.0, 1400.0).expect("13x6 bands must yield a grid");
        assert_eq!(grid.row_bands.len(), 13);
        assert_eq!(grid.col_bands.len(), 6);
        // Scaled into page pixels, and still a contiguous tiling.
        assert_eq!(
            grid.col_bands[0],
            Span {
                lo: 12.0,
                hi: 111.0
            }
        );
        for pair in grid.col_bands.windows(2) {
            assert_eq!(pair[0].hi, pair[1].lo, "columns must still tile");
        }
        assert_eq!(grid.row_bands[0], Span { lo: 0.0, hi: 84.0 });
    }

    #[test]
    fn bands_are_sorted_into_reading_order() {
        let bands = Bands {
            rows: vec![row(500.0, 600.0), row(100.0, 200.0)],
            cols: vec![col(600.0, 900.0), col(0.0, 300.0)],
            rejected: 0,
        };
        let grid = declared_grid(&bands, 1000.0, 1000.0).expect("grid");
        assert!(grid.row_bands[0].lo < grid.row_bands[1].lo);
        assert!(grid.col_bands[0].lo < grid.col_bands[1].lo);
    }

    /// A single column has no horizontal structure worth declaring — the same bar
    /// `detectTableGrid` applies before inferring one.
    #[test]
    fn fewer_than_two_columns_is_not_a_grid() {
        let one = Bands {
            rows: vec![row(0.0, 100.0)],
            cols: vec![col(0.0, 500.0)],
            rejected: 0,
        };
        assert!(declared_grid(&one, 1000.0, 1000.0).is_none());

        let no_rows = Bands {
            rows: vec![],
            cols: vec![col(0.0, 500.0), col(500.0, 900.0)],
            rejected: 0,
        };
        assert!(declared_grid(&no_rows, 1000.0, 1000.0).is_none());
    }

    /// One bad band costs us that band, not the page.
    #[test]
    fn degenerate_bands_are_dropped_and_the_rest_survive() {
        let bands = Bands {
            rows: vec![row(100.0, 100.0), row(200.0, 300.0)],
            cols: vec![col(0.0, 300.0), col(300.0, 600.0), col(900.0, 800.0)],
            rejected: 0,
        };
        let grid = declared_grid(&bands, 1000.0, 1000.0).expect("grid");
        assert_eq!(grid.row_bands.len(), 1, "zero-height row dropped");
        // The inverted column is a legitimate rectangle written backwards, so it
        // survives normalization rather than being discarded.
        assert_eq!(grid.col_bands.len(), 3);
        assert_eq!(
            grid.col_bands[2],
            Span {
                lo: 800.0,
                hi: 900.0
            }
        );
    }

    #[test]
    fn empty_bands_produce_no_grid() {
        assert!(declared_grid(&Bands::default(), 1000.0, 1000.0).is_none());
    }

    #[test]
    fn the_declared_grid_serializes_with_camelcase_keys() {
        // The frontend consumes this shape directly; snake_case here would arrive as
        // `undefined` on the other side with no error.
        let grid = DeclaredGrid {
            row_bands: vec![Span { lo: 1.0, hi: 2.0 }],
            col_bands: vec![Span { lo: 3.0, hi: 4.0 }],
        };
        let json = serde_json::to_string(&grid).expect("serialize");
        assert!(json.contains("\"rowBands\""), "{json}");
        assert!(json.contains("\"colBands\""), "{json}");
        assert!(json.contains("\"lo\":1.0"), "{json}");
    }

    // ---- table-mode band parsing ----

    #[test]
    fn parses_the_prompted_band_shape() {
        let raw = r#"[{"label": "Row", "bbox": [10, 20, 990, 60]},
                      {"label": "Col", "bbox": [10, 20, 200, 900]},
                      {"label": "Col", "bbox": [200, 20, 500, 900]}]"#;
        let bands = parse_bands(raw);
        assert_eq!(bands.rows.len(), 1);
        assert_eq!(bands.cols.len(), 2);
        assert_eq!(bands.rejected, 0);
        assert_eq!(bands.rows[0].x1, 990.0);
    }

    #[test]
    fn tolerates_a_code_fence_and_a_wrapper_object() {
        let fenced = "```json\n[{\"label\":\"Row\",\"bbox\":[0,0,10,10]}]\n```";
        assert_eq!(parse_bands(fenced).rows.len(), 1);

        let wrapped = r#"{"bands": [{"label":"Col","bbox":[0,0,10,10]},{"label":"Col","bbox":[10,0,20,10]}]}"#;
        assert_eq!(parse_bands(wrapped).cols.len(), 2);
    }

    #[test]
    fn tolerates_prose_around_the_array() {
        let chatty = "Here is the table structure:\n[{\"label\":\"Row\",\"bbox\":[0,0,10,10]}]\nHope that helps.";
        assert_eq!(parse_bands(chatty).rows.len(), 1);
    }

    #[test]
    fn accepts_the_alternate_key_and_string_bbox_spellings() {
        let raw = r#"[{"type":"Rows","box":"0 0 10 10"},{"type":"Column","box":"10,0,20,10"}]"#;
        let bands = parse_bands(raw);
        assert_eq!(bands.rows.len(), 1);
        assert_eq!(bands.cols.len(), 1);
        assert_eq!(bands.cols[0].x0, 10.0);
    }

    /// Unreadable entries are counted, not silently dropped: "the model returned
    /// nothing" and "the model returned something we could not read" need different
    /// responses, and only the count can tell them apart.
    #[test]
    fn unusable_entries_are_counted_as_rejected() {
        let raw = r#"[{"label":"Row","bbox":[0,0,10]},
                      {"label":"Picture","bbox":[0,0,10,10]},
                      {"label":"Row","bbox":"nonsense"},
                      {"label":"Row","bbox":[0,0,10,10]}]"#;
        let bands = parse_bands(raw);
        assert_eq!(bands.rows.len(), 1);
        assert_eq!(bands.rejected, 3);
    }

    #[test]
    fn unparseable_output_yields_empty_bands_rather_than_panicking() {
        for raw in ["", "I could not find a table.", "{", "null", "[}"] {
            let bands = parse_bands(raw);
            assert!(bands.rows.is_empty() && bands.cols.is_empty(), "{raw:?}");
        }
    }

    // ---- ocr-mode block parsing ----

    const SAMPLE_HTML: &str = concat!(
        r#"<div data-label="PageHeader" data-bbox="10 10 990 40">Transcript</div>"#,
        "\n",
        r#"<div data-label="Table" data-bbox="10 60 990 900"><table><tr><td>BUSINESS 1299E</td><td>A+</td></tr></table></div>"#,
    );

    #[test]
    fn parses_blocks_with_labels_boxes_and_text() {
        let blocks = parse_blocks(SAMPLE_HTML);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].label, "PageHeader");
        assert_eq!(blocks[0].text, "Transcript");
        assert_eq!(
            blocks[0].bbox,
            Some(NormBox {
                x0: 10.0,
                y0: 10.0,
                x1: 990.0,
                y1: 40.0
            })
        );
        assert_eq!(blocks[1].label, "Table");
        assert_eq!(blocks[1].text, "BUSINESS 1299E A+");
        // The table markup rides along inside the block rather than being a block.
        assert!(blocks[1].inner_html.starts_with("<table>"));
    }

    /// The offsets are what let the grounder's own logprobs be attributed to the text
    /// it produced, exactly as `parseTSVWithOffsets` does for the structuring model.
    #[test]
    fn block_offsets_address_the_inner_html_in_the_raw_output() {
        let blocks = parse_blocks(SAMPLE_HTML);
        let b = &blocks[0];
        let raw16: Vec<u16> = SAMPLE_HTML.encode_utf16().collect();
        let slice = String::from_utf16(&raw16[b.char_start..b.char_end]).unwrap();
        assert_eq!(slice, "Transcript");
    }

    /// Byte offsets and UTF-16 offsets agree only for ASCII. An accented character in
    /// an earlier block is exactly how a silent misalignment gets introduced.
    #[test]
    fn offsets_are_utf16_code_units_not_bytes() {
        let html = concat!(
            r#"<div data-label="Text" data-bbox="0 0 10 10">Crédit</div>"#,
            r#"<div data-label="Text" data-bbox="0 20 10 30">Grade</div>"#,
        );
        let blocks = parse_blocks(html);
        assert_eq!(blocks.len(), 2);

        let raw16: Vec<u16> = html.encode_utf16().collect();
        let second = &blocks[1];
        assert_eq!(
            String::from_utf16(&raw16[second.char_start..second.char_end]).unwrap(),
            "Grade"
        );
        // "Crédit" is 6 UTF-16 units but 7 UTF-8 bytes, so the byte offset a naive
        // implementation would report is exactly one too high.
        let byte_offset = html.rfind("Grade").expect("fixture contains Grade");
        assert_eq!(second.char_start, byte_offset - 1);
    }

    #[test]
    fn a_nested_div_does_not_split_its_parent_block() {
        let html = r#"<div data-label="ListGroup" data-bbox="0 0 10 10">a<div>inner</div>b</div>"#;
        let blocks = parse_blocks(html);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "a inner b");
    }

    /// A truncated response must yield the blocks it did finish.
    #[test]
    fn a_truncated_response_keeps_its_completed_blocks() {
        let html = concat!(
            r#"<div data-label="Text" data-bbox="0 0 10 10">done</div>"#,
            r#"<div data-label="Text" data-bbox="0 20 10 30">unfinis"#,
        );
        let blocks = parse_blocks(html);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "done");
    }

    #[test]
    fn stray_closing_tags_are_tolerated() {
        let html = r#"</div><div data-label="Text" data-bbox="0 0 10 10">ok</div></div>"#;
        let blocks = parse_blocks(html);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "ok");
    }

    #[test]
    fn a_tag_merely_starting_with_div_is_not_a_block() {
        let html = r#"<divider/><div data-label="Text" data-bbox="0 0 10 10">real</div>"#;
        let blocks = parse_blocks(html);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "real");
    }

    #[test]
    fn a_block_without_geometry_keeps_its_text() {
        let blocks = parse_blocks("<div data-label=\"Text\">no box here</div>");
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].bbox.is_none());
        assert_eq!(blocks[0].text, "no box here");
    }

    #[test]
    fn single_quoted_and_uppercase_attributes_are_read() {
        let blocks = parse_blocks("<DIV DATA-LABEL='Text' DATA-BBOX='0 0 10 10'>x</DIV>");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].label, "Text");
        assert!(blocks[0].bbox.is_some());
    }

    /// Provenance matches this text against the table's cells, so a literal `&amp;`
    /// where the page shows `&` is a mismatch, not a cosmetic difference.
    #[test]
    fn entities_are_decoded_and_whitespace_collapsed() {
        let blocks = parse_blocks(
            "<div data-label=\"Text\" data-bbox=\"0 0 1 1\">A&amp;B&nbsp;&nbsp;C\n   D &lt;x&gt;</div>",
        );
        assert_eq!(blocks[0].text, "A&B C D <x>");
    }

    #[test]
    fn empty_html_yields_no_blocks() {
        assert!(parse_blocks("").is_empty());
        assert!(parse_blocks("just prose, no markup").is_empty());
    }
}
