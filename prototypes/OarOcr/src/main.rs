//! Quick spike: can `oar-ocr` (pure Rust, no Python, ONNX Runtime via `ort`)
//! give per-word text + box + confidence, the same shape `ocr.rs`'s `OcrWord`
//! needs, without shelling out to anything?
//!
//! Preprocessing mirrors `app/src-tauri/src/ocr.rs::preprocess_for_ocr` exactly
//! (grayscale -> 2x Lanczos upscale below the 1500px narrow-side threshold),
//! same as the Python RapidOCR spike, so results are comparable across both.

use std::path::PathBuf;

use image::{DynamicImage, GenericImageView, Rgb};
use oar_ocr::prelude::*;
use oar_ocr::processors::BoundingBox;
use serde::Serialize;

// Mirrors ocr.rs::UPSCALE_NARROW_SIDE_THRESHOLD and the 2.0 factor in
// upscale_factor(). Kept in sync by hand -- this is a spike, not a shared dep.
const UPSCALE_NARROW_SIDE_THRESHOLD: u32 = 1500;
const UPSCALE_FACTOR: f32 = 2.0;

#[derive(Serialize)]
struct OcrWordOut {
    text: String,
    confidence: f32,
    box_coords: BoxCoords,
}

#[derive(Serialize)]
struct BoxCoords {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
}

fn upscale_factor(w: u32, h: u32) -> f32 {
    if w.min(h) < UPSCALE_NARROW_SIDE_THRESHOLD {
        UPSCALE_FACTOR
    } else {
        1.0
    }
}

/// Grayscale -> Lanczos upscale (if narrow side < threshold) -> (RgbImage, scale).
/// Bit-for-bit mirror of ocr.rs::preprocess_for_ocr (see module doc).
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

fn bbox_rect(b: &BoundingBox) -> (f32, f32, f32, f32) {
    (b.x_min(), b.y_min(), b.x_max(), b.y_max())
}

fn union_boxes(boxes: &[&BoundingBox]) -> BoundingBox {
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
    BoundingBox::from_coords(x_min, y_min, x_max, y_max)
}

/// oar-ocr's `word_boxes` is, despite the name, one box PER CHARACTER of the
/// recognized line (see `ctc_word_boxes` in its source -- it loops one box per
/// CTC column, with no whitespace grouping at all). There is no per-word text
/// or confidence anywhere in its output; both stay at line granularity.
///
/// This reconstructs real word boxes by splitting the line's text on
/// whitespace and unioning the corresponding run of character boxes -- the
/// glue code a real integration would need, not something the crate gives you
/// for free. Confidence is NOT reconstructed per word: every word inherits its
/// parent line's score, which is a real accuracy loss vs. RapidOCR's Python
/// path (see README).
fn split_into_words(text: &str, char_boxes: &[BoundingBox]) -> Vec<(String, BoundingBox)> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() != char_boxes.len() {
        // Lengths should line up 1:1 (one box per char); if they don't, don't
        // guess at an alignment -- surface nothing rather than a wrong box.
        return Vec::new();
    }

    let mut words = Vec::new();
    let mut cur_text = String::new();
    let mut cur_boxes: Vec<&BoundingBox> = Vec::new();

    for (ch, b) in chars.iter().zip(char_boxes.iter()) {
        if ch.is_whitespace() {
            if !cur_text.is_empty() {
                words.push((std::mem::take(&mut cur_text), union_boxes(&cur_boxes)));
                cur_boxes.clear();
            }
        } else {
            cur_text.push(*ch);
            cur_boxes.push(b);
        }
    }
    if !cur_text.is_empty() {
        words.push((cur_text, union_boxes(&cur_boxes)));
    }
    words
}

fn to_word_out(text: String, region_box: &BoundingBox, confidence: f32, scale: f32) -> OcrWordOut {
    let (x0, y0, x1, y1) = bbox_rect(region_box);
    OcrWordOut {
        text,
        confidence: confidence * 100.0, // match OcrWord's 0-100 scale
        box_coords: BoxCoords {
            // Divide back by `scale` into the original image's coordinate
            // space -- the same invariant ocr.rs's map_coord enforces.
            left: (x0 / scale).round() as i32,
            top: (y0 / scale).round() as i32,
            width: ((x1 - x0) / scale).round() as i32,
            height: ((y1 - y0) / scale).round() as i32,
        },
    }
}

fn draw_overlay(
    original: &DynamicImage,
    words: &[OcrWordOut],
    out_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use imageproc::drawing::draw_hollow_rect_mut;
    use imageproc::rect::Rect;

    let mut canvas = original.to_rgb8();
    for w in words {
        let color = if w.confidence >= 85.0 {
            Rgb([0u8, 200, 0])
        } else if w.confidence >= 60.0 {
            Rgb([255u8, 140, 0])
        } else {
            Rgb([220u8, 0, 0])
        };
        let rect = Rect::at(w.box_coords.left, w.box_coords.top).of_size(
            w.box_coords.width.max(1) as u32,
            w.box_coords.height.max(1) as u32,
        );
        draw_hollow_rect_mut(&mut canvas, rect, color);
    }
    canvas.save(out_path)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let image_path = if args.len() > 1 {
        PathBuf::from(&args[1])
    } else {
        let default = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../OCR/sample_invoice.png");
        println!("No image given, using default: {}", default.display());
        default
    };

    if !image_path.exists() {
        eprintln!("Image not found: {}", image_path.display());
        std::process::exit(1);
    }

    let original = image::open(&image_path)?;
    let (preprocessed, scale) = preprocess(&original);
    println!(
        "Preprocessed: {:?} -> {:?} (scale={scale})",
        original.dimensions(),
        preprocessed.dimensions()
    );

    // Named model identifiers, resolved via ModelScope auto-download and
    // cached in $OAR_HOME (SHA-256 verified) -- same PP-OCRv6 "small" family
    // the Python RapidOCR spike used, for an apples-to-apples comparison.
    println!("Building pipeline (first run downloads ~30MB of ONNX models)...");
    let ocr = OAROCRBuilder::new(
        "pp-ocrv6_small_det.onnx",
        "pp-ocrv6_small_rec.onnx",
        "ppocrv6_dict.txt",
    )
    .return_word_box(true)
    .build()?;

    let started = std::time::Instant::now();
    let results = ocr.predict(vec![preprocessed])?;
    let elapsed = started.elapsed();
    let result = &results[0];

    let mut words_out: Vec<OcrWordOut> = Vec::new();
    let mut lines_with_word_split = 0usize;
    let mut lines_without_word_split = 0usize;

    for region in &result.text_regions {
        let Some((text, confidence)) = region.text_with_confidence() else {
            continue;
        };

        match &region.word_boxes {
            Some(char_boxes) => {
                let words = split_into_words(text, char_boxes);
                if words.is_empty() {
                    // Length mismatch fallback: emit the whole line as one entry
                    // rather than silently dropping it.
                    words_out.push(to_word_out(
                        text.to_string(),
                        &region.bounding_box,
                        confidence,
                        scale,
                    ));
                    lines_without_word_split += 1;
                } else {
                    for (word_text, word_box) in words {
                        words_out.push(to_word_out(word_text, &word_box, confidence, scale));
                    }
                    lines_with_word_split += 1;
                }
            }
            None => {
                words_out.push(to_word_out(
                    text.to_string(),
                    &region.bounding_box,
                    confidence,
                    scale,
                ));
                lines_without_word_split += 1;
            }
        }
    }

    println!(
        "oar-ocr: {} lines detected ({} word-split, {} kept as whole lines), {} words emitted, {:.2}s",
        result.text_regions.len(),
        lines_with_word_split,
        lines_without_word_split,
        words_out.len(),
        elapsed.as_secs_f32()
    );

    std::fs::create_dir_all("out")?;
    let stem = image_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());

    let json_path = format!("out/{stem}.oarocr.json");
    std::fs::write(&json_path, serde_json::to_string_pretty(&words_out)?)?;
    println!("Wrote {json_path}");

    let overlay_path = format!("out/{stem}.oarocr.overlay.png");
    draw_overlay(&original, &words_out, &overlay_path)?;
    println!("Wrote {overlay_path}");

    if !words_out.is_empty() {
        let confs: Vec<f32> = words_out.iter().map(|w| w.confidence).collect();
        let mean = confs.iter().sum::<f32>() / confs.len() as f32;
        let min = confs.iter().cloned().fold(f32::INFINITY, f32::min);
        let max = confs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        println!("Confidence: mean={mean:.1} min={min:.1} max={max:.1}");
    } else {
        println!("No words detected.");
    }

    Ok(())
}
