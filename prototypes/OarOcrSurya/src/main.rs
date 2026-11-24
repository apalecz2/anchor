//! Spike: can oar-ocr's words + Surya's table grid build a TSV table with
//! **no LLM structuring pass at all** -- no Qwen, no per-page model call for
//! the table itself, just row-band x col-band intersection over oar-ocr's
//! word boxes?
//!
//! This answers a scoping question raised while extending the real app's
//! pipeline catalog: a preset with no `Structure` step can't produce a table
//! today (see `app/src-tauri/src/pipeline/executor.rs`'s `run_page` -- the
//! `PageArtifact` is only ever built inside the Structure/Verify branch).
//! Before investing in a real "assemble the table algorithmically" step and
//! app-side plumbing, this checks whether the *output quality* of that idea
//! is even good enough to bother with.
//!
//! Usage:
//!   node ../Surya/surya.mjs serve --port 8099   # start Surya once, elsewhere
//!   cargo run -- ../OCR/sample_invoice.png --port 8099
//!
//! See README.md for output format and what this can't do (no semantic
//! correction, no handling of wrapped/merged cells beyond raw geometry).

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{DynamicImage, GenericImageView, Rgb};
use oar_ocr::prelude::*;
use oar_ocr::processors::BoundingBox as OarBox;
use serde::Serialize;

// ---- preprocessing (mirrors ocr.rs::preprocess_for_ocr / prototypes/OarOcr) ----

const UPSCALE_NARROW_SIDE_THRESHOLD: u32 = 1500;
const UPSCALE_FACTOR: f32 = 2.0;

fn upscale_factor(w: u32, h: u32) -> f32 {
    if w.min(h) < UPSCALE_NARROW_SIDE_THRESHOLD {
        UPSCALE_FACTOR
    } else {
        1.0
    }
}

fn preprocess(img: &DynamicImage) -> (image::RgbImage, f32) {
    let (w, h) = img.dimensions();
    let scale = upscale_factor(w, h);
    let gray = img.grayscale();
    let resized = if scale != 1.0 {
        gray.resize_exact(
            (w as f32 * scale) as u32,
            (h as f32 * scale) as u32,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        gray
    };
    (resized.to_rgb8(), scale)
}

// ---- oar-ocr word extraction (see prototypes/OarOcr for the full writeup) ----

#[derive(Serialize, Clone)]
struct BoxCoords {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

impl BoxCoords {
    fn center_x(&self) -> f64 {
        self.left + self.width / 2.0
    }
    fn center_y(&self) -> f64 {
        self.top + self.height / 2.0
    }
}

#[derive(Serialize, Clone)]
struct Word {
    text: String,
    confidence: f32,
    box_coords: BoxCoords,
}

fn oar_bbox_rect(b: &OarBox) -> (f64, f64, f64, f64) {
    (
        b.x_min() as f64,
        b.y_min() as f64,
        b.x_max() as f64,
        b.y_max() as f64,
    )
}

fn union_oar_boxes(boxes: &[&OarBox]) -> OarBox {
    let mut x_min = f32::INFINITY;
    let mut y_min = f32::INFINITY;
    let mut x_max = f32::NEG_INFINITY;
    let mut y_max = f32::NEG_INFINITY;
    for b in boxes {
        x_min = x_min.min(b.x_min());
        y_min = y_min.min(b.y_min());
        x_max = x_max.max(b.x_max());
        y_max = y_max.max(b.y_max());
    }
    OarBox::from_coords(x_min, y_min, x_max, y_max)
}

/// oar-ocr's `word_boxes` is one box PER CHARACTER, not per word (see
/// `ctc_word_boxes` in the crate's source) -- split on whitespace and union
/// the corresponding run into a real word box. Same glue as prototypes/OarOcr
/// and the app's `ocr.rs::split_into_words`.
fn split_into_words(text: &str, char_boxes: &[OarBox]) -> Vec<(String, OarBox)> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() != char_boxes.len() {
        return Vec::new();
    }
    let mut words = Vec::new();
    let mut cur_text = String::new();
    let mut cur_boxes: Vec<&OarBox> = Vec::new();
    for (ch, b) in chars.iter().zip(char_boxes.iter()) {
        if ch.is_whitespace() {
            if !cur_text.is_empty() {
                words.push((std::mem::take(&mut cur_text), union_oar_boxes(&cur_boxes)));
                cur_boxes.clear();
            }
        } else {
            cur_text.push(*ch);
            cur_boxes.push(b);
        }
    }
    if !cur_text.is_empty() {
        words.push((cur_text, union_oar_boxes(&cur_boxes)));
    }
    words
}

/// Runs oar-ocr on the preprocessed image and returns words with boxes divided
/// back into the ORIGINAL image's pixel space (dividing out `scale`) -- the
/// same space Surya's bands get converted into below, so the two can be
/// intersected directly.
fn run_oar_ocr(preprocessed: image::RgbImage, scale: f32) -> Result<Vec<Word>, String> {
    let engine = OAROCRBuilder::new(
        "pp-ocrv6_small_det.onnx",
        "pp-ocrv6_small_rec.onnx",
        "ppocrv6_dict.txt",
    )
    .return_word_box(true)
    .build()
    .map_err(|e| format!("failed to build oar-ocr pipeline: {e}"))?;

    let mut results = engine
        .predict(vec![preprocessed])
        .map_err(|e| format!("oar-ocr failed: {e}"))?;
    let page = results.pop().ok_or("oar-ocr returned no page result")?;

    let mut words = Vec::new();
    for region in &page.text_regions {
        let Some((text, confidence)) = region.text_with_confidence() else {
            continue;
        };
        let boxes: Vec<(String, OarBox)> = match &region.word_boxes {
            Some(char_boxes) => {
                let split = split_into_words(text, char_boxes);
                if split.is_empty() {
                    vec![(text.to_string(), region.bounding_box.clone())]
                } else {
                    split
                }
            }
            None => vec![(text.to_string(), region.bounding_box.clone())],
        };
        for (word_text, b) in boxes {
            let (x0, y0, x1, y1) = oar_bbox_rect(&b);
            words.push(Word {
                text: word_text,
                confidence: confidence * 100.0,
                box_coords: BoxCoords {
                    left: x0 as f64 / scale as f64,
                    top: y0 as f64 / scale as f64,
                    width: (x1 - x0) as f64 / scale as f64,
                    height: (y1 - y0) as f64 / scale as f64,
                },
            });
        }
    }
    Ok(words)
}

// ---- Surya table grid (ported from app/src-tauri/src/pipeline/surya.rs) ----
//
// Same parsing/geometry as the app's real `surya.rs` -- copied rather than
// linked because this is a standalone binary with no dependency on the app
// crate. Kept in sync by hand; this is a spike, not a shared library.

const NORM_SCALE: f64 = 1000.0;
const SURYA_TABLE_PROMPT: &str = "Output the table rows then columns as JSON. Each entry is a dict with \"label\" (\"Row\" or \"Col\") and \"bbox\" (x0 y0 x1 y1, normalized 0-1000).";
const SURYA_MAX_TOKENS: u32 = 12288; // surya/settings.py default, matches surya.mjs

#[derive(Debug, Clone, Copy)]
struct NormBox {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

#[derive(Debug, Clone, Copy)]
struct Span {
    lo: f64,
    hi: f64,
}

#[derive(Debug, Clone, Default)]
struct Bands {
    rows: Vec<NormBox>,
    cols: Vec<NormBox>,
    rejected: usize,
}

struct DeclaredGrid {
    row_bands: Vec<Span>,
    col_bands: Vec<Span>,
}

fn extract_json_array(raw: &str) -> Option<Vec<serde_json::Value>> {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("```") {
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

fn parse_bands(raw: &str) -> Bands {
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
    bands.rows.sort_by(|a, b| a.y0.total_cmp(&b.y0));
    bands.cols.sort_by(|a, b| a.x0.total_cmp(&b.x0));
    bands
}

fn declared_grid(bands: &Bands, width: f64, height: f64) -> Option<DeclaredGrid> {
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

/// POST the ORIGINAL (natural-resolution) image to a running `llama-server`
/// serving Surya, using the exact "table" mode request `surya.mjs`/the app's
/// `executor.rs` use, and returns the raw text content for `parse_bands`.
fn call_surya_table(port: u16, image_path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(image_path).map_err(|e| format!("failed to read image: {e}"))?;
    let mime = if image_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
        .unwrap_or(false)
    {
        "image/jpeg"
    } else {
        "image/png"
    };
    let data_url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));

    let body = serde_json::json!({
        "model": "surya-ocr-2",
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url } },
                { "type": "text", "text": SURYA_TABLE_PROMPT },
            ],
        }],
        "temperature": 0.0,
        "top_p": 0.1,
        "max_tokens": SURYA_MAX_TOKENS,
        "stream": false,
    });

    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let response: serde_json::Value = ureq::post(&url)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("request to Surya server at {url} failed: {e}"))?
        .into_json()
        .map_err(|e| format!("failed to parse Surya's response as JSON: {e}"))?;

    response["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("unexpected response shape from Surya: {response}"))
}

// ---- table assembly: row-band x col-band intersection over oar-ocr words ----

/// For each row x col cell, collect words whose box CENTER falls inside both
/// spans, sort left-to-right, and join with a space -- the entire "structuring"
/// step. No model, no semantic correction: purely geometric.
fn assemble_table(grid: &DeclaredGrid, words: &[Word]) -> (Vec<Vec<String>>, Vec<Word>) {
    let mut claimed = vec![false; words.len()];
    let mut rows = Vec::with_capacity(grid.row_bands.len());

    for row in &grid.row_bands {
        let mut cells = Vec::with_capacity(grid.col_bands.len());
        for col in &grid.col_bands {
            let mut cell_words: Vec<(usize, &Word)> = words
                .iter()
                .enumerate()
                .filter(|(_, w)| {
                    let cy = w.box_coords.center_y();
                    let cx = w.box_coords.center_x();
                    cy >= row.lo && cy <= row.hi && cx >= col.lo && cx <= col.hi
                })
                .collect();
            cell_words.sort_by(|a, b| a.1.box_coords.left.total_cmp(&b.1.box_coords.left));
            for (i, _) in &cell_words {
                claimed[*i] = true;
            }
            let text = cell_words
                .iter()
                .map(|(_, w)| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            cells.push(text);
        }
        rows.push(cells);
    }

    let unclaimed = words
        .iter()
        .zip(claimed.iter())
        .filter(|(_, &c)| !c)
        .map(|(w, _)| w.clone())
        .collect();

    (rows, unclaimed)
}

fn rows_to_tsv(rows: &[Vec<String>]) -> String {
    rows.iter()
        .map(|r| r.join("\t"))
        .collect::<Vec<_>>()
        .join("\n")
}

// ---- overlay ----

fn draw_overlay(
    original: &DynamicImage,
    grid: &DeclaredGrid,
    words: &[Word],
    out_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use imageproc::drawing::{draw_hollow_rect_mut, draw_line_segment_mut};
    use imageproc::rect::Rect;

    let mut canvas = original.to_rgb8();
    let (w, h) = (canvas.width() as f32, canvas.height() as f32);

    for row in &grid.row_bands {
        draw_line_segment_mut(
            &mut canvas,
            (0.0, row.lo as f32),
            (w, row.lo as f32),
            Rgb([0, 0, 255]),
        );
        draw_line_segment_mut(
            &mut canvas,
            (0.0, row.hi as f32),
            (w, row.hi as f32),
            Rgb([0, 0, 255]),
        );
    }
    for col in &grid.col_bands {
        draw_line_segment_mut(
            &mut canvas,
            (col.lo as f32, 0.0),
            (col.lo as f32, h),
            Rgb([255, 0, 255]),
        );
        draw_line_segment_mut(
            &mut canvas,
            (col.hi as f32, 0.0),
            (col.hi as f32, h),
            Rgb([255, 0, 255]),
        );
    }
    for word in words {
        let b = &word.box_coords;
        let rect = Rect::at(b.left.round() as i32, b.top.round() as i32)
            .of_size(b.width.max(1.0).round() as u32, b.height.max(1.0).round() as u32);
        draw_hollow_rect_mut(&mut canvas, rect, Rgb([0, 200, 0]));
    }
    canvas.save(out_path)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let mut image_path: Option<PathBuf> = None;
    let mut port: u16 = 8099;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                port = args
                    .get(i + 1)
                    .ok_or("--port needs a value")?
                    .parse()
                    .map_err(|_| "invalid --port value")?;
                i += 2;
            }
            other => {
                image_path = Some(PathBuf::from(other));
                i += 1;
            }
        }
    }
    let image_path = image_path.unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../OCR/sample_invoice.png")
    });

    if !image_path.exists() {
        eprintln!("Image not found: {}", image_path.display());
        std::process::exit(1);
    }

    println!("1. oar-ocr: reading words from {}...", image_path.display());
    let original = image::open(&image_path)?;
    let (nat_w, nat_h) = original.dimensions();
    let (preprocessed, scale) = preprocess(&original);
    let words = run_oar_ocr(preprocessed, scale)?;
    println!("   {} words detected", words.len());

    println!("2. Surya (port {port}): fetching the table grid...");
    let raw_bands = call_surya_table(port, &image_path)?;
    let bands = parse_bands(&raw_bands);
    println!(
        "   {} row bands, {} col bands, {} rejected entries",
        bands.rows.len(),
        bands.cols.len(),
        bands.rejected
    );
    let grid = declared_grid(&bands, nat_w as f64, nat_h as f64)
        .ok_or("Surya's bands did not describe a usable grid (need >=1 row and >=2 cols)")?;

    println!("3. Assembling the table from grid ∩ words (no LLM)...");
    let (rows, unclaimed) = assemble_table(&grid, &words);
    if !unclaimed.is_empty() {
        println!(
            "   {} words fell outside every cell (see the .unclaimed.json output)",
            unclaimed.len()
        );
    }

    std::fs::create_dir_all("out")?;
    let stem = image_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());

    let tsv = rows_to_tsv(&rows);
    let tsv_path = format!("out/{stem}.notool.tsv");
    std::fs::write(&tsv_path, &tsv)?;
    println!("Wrote {tsv_path}");

    std::fs::write(
        format!("out/{stem}.notool.unclaimed.json"),
        serde_json::to_string_pretty(&unclaimed)?,
    )?;

    let overlay_path = format!("out/{stem}.notool.overlay.png");
    draw_overlay(&original, &grid, &words, &overlay_path)?;
    println!("Wrote {overlay_path}");

    println!("\n--- TSV (no Qwen pass) ---\n{tsv}\n");

    Ok(())
}
