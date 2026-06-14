//! Document processing and OCR.
//!
//! Renders PDFs/images to PNGs, preprocesses them for Tesseract, runs OCR, and
//! returns per-page text + word bounding boxes. Also owns Tesseract environment
//! configuration, which must run before every OCR call (see
//! [`configure_tesseract_env`]).

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use pdfium_render::prelude::*;

use image::{DynamicImage, GenericImageView, GrayImage};

use tauri::Manager;

use crate::paths::pdfium_lib_name;

const MAX_FILE_SIZE_BYTES: u64 = 500 * 1024 * 1024; // 500 MB

#[derive(Serialize, Deserialize)]
pub struct BoundingBox {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Deserialize)]
pub struct OcrWord {
    pub text: String,
    pub confidence: f32,
    pub box_coords: BoundingBox,
}

#[derive(Serialize, Deserialize)]
pub struct DocumentPageResult {
    pub image_path: String, // generated PNG path
    pub natural_width: i32,
    pub natural_height: i32,
    pub words: Vec<OcrWord>,
    pub text: String,
}

#[derive(Serialize, Deserialize)]
pub struct ExtractionResult {
    pub session_id: String,
    pub pages: Vec<DocumentPageResult>,
}

const UPSCALE_NARROW_SIDE_THRESHOLD: u32 = 1500;

/// Produce a preprocessed copy of `source` for Tesseract.
/// Returns (preprocessed_path, scale_factor). Callers divide OCR bounding boxes by
/// scale_factor to map back to original-image coordinates.
///
/// Pipeline: grayscale ->  Lanczos upscale (if narrow side < threshold) -> save.
/// Tesseract binarizes internally, which handles thin antialiased screen fonts
/// better than a hard global threshold on native-resolution pixels.
fn preprocess_for_ocr(
    source: &Path,
    out_dir: &Path,
    allow_upscale: bool,
) -> Result<(PathBuf, f32), String> {
    let img = image::open(source)
        .map_err(|e| format!("failed to open image for preprocessing: {e}"))?;

    let (w, h) = img.dimensions();
    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("page");
    let scale: f32 = if allow_upscale && w.min(h) < UPSCALE_NARROW_SIDE_THRESHOLD { 2.0 } else { 1.0 };

    let gray: GrayImage = img.grayscale().to_luma8();

    let upscaled = if scale != 1.0 {
        DynamicImage::ImageLuma8(gray)
            .resize_exact(
                (w as f32 * scale) as u32,
                (h as f32 * scale) as u32,
                image::imageops::FilterType::Lanczos3,
            )
            .to_luma8()
    } else {
        gray
    };

    let out_path = out_dir.join(format!("{stem}_ocr.png"));
    DynamicImage::ImageLuma8(upscaled)
        .save(&out_path)
        .map_err(|e| format!("failed to save preprocessed image: {e}"))?;

    Ok((out_path, scale))
}

fn ocr_image_to_page(
    image_path: &Path,
    natural_width: i32,
    natural_height: i32,
    out_dir: &Path,
    allow_upscale: bool,
) -> Result<DocumentPageResult, String> {
    let (ocr_path, scale) = preprocess_for_ocr(image_path, out_dir, allow_upscale)?;

    let mut args = rusty_tesseract::Args::default();
    args.lang = "eng".to_string();
    args.psm = Some(6);  // single uniform block — better for tabular layouts
    args.dpi = None;     // let Tesseract estimate from image; the default 150 misrepresents upscaled content

    let tesseract_image = rusty_tesseract::tesseract::input::Image::from_path(&ocr_path)
        .map_err(|error| format!("failed to load image for ocr: {error}"))?;

    let ocr_output = rusty_tesseract::tesseract::output_data::image_to_data(&tesseract_image, &args)
        .map_err(|error| format!("ocr failed: {error}"))?;

    let words = ocr_output
        .data
        .into_iter()
        .filter(|item| item.level == 5 && !item.text.trim().is_empty())
        .map(|item| OcrWord {
            text: item.text,
            confidence: item.conf,
            box_coords: BoundingBox {
                left:   (item.left   as f32 / scale).round() as i32,
                top:    (item.top    as f32 / scale).round() as i32,
                width:  (item.width  as f32 / scale).round() as i32,
                height: (item.height as f32 / scale).round() as i32,
            },
        })
        .collect::<Vec<_>>();

    Ok(DocumentPageResult {
        image_path: image_path.to_string_lossy().into_owned(),
        natural_width,
        natural_height,
        words,
        text: ocr_output.output,
    })
}

#[tauri::command]
pub async fn process_document(
    app_handle: tauri::AppHandle,
    session_id: String,
    file_path: String
) -> Result<ExtractionResult, String> {
    let source_path = Path::new(&file_path);

    if !source_path.exists() {
        return Err(format!("Input file does not exist: {file_path}"));
    }

    let file_size = fs::metadata(source_path)
        .map_err(|e| format!("Failed to read file metadata: {e}"))?
        .len();

    if file_size > MAX_FILE_SIZE_BYTES {
        return Err(format!(
            "File exceeds the 500 MB size limit ({} bytes)",
            file_size
        ));
    }

    let extension = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Make sure the bundled Tesseract is on PATH / TESSDATA_PREFIX before OCR.
    // The startup hook can't do this when Tesseract was installed by the wizard
    // earlier in this same session, so do it here too (idempotent).
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    configure_tesseract_env(&data_dir);

    let eng_traineddata = data_dir.join("tesseract").join("tessdata").join("eng.traineddata");
    if !eng_traineddata.exists() {
        return Err(format!(
            "Tesseract English language data not found at {}. Re-run setup to reinstall Tesseract.",
            eng_traineddata.display()
        ));
    }

    // Ensure the `tsv` output config exists even if the Tesseract package shipped
    // without its configs/ dir — otherwise OCR silently returns plain text.
    ensure_tesseract_tsv_config(&data_dir);

    let session_dir = app_handle
        .path()
        .resolve("sessions", tauri::path::BaseDirectory::AppData)
        .map_err(|error| format!("failed to resolve output directory: {error}"))?;

    std::fs::create_dir_all(&session_dir)
        .map_err(|error| format!("failed to create output directory: {error}"))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let mut pages: Vec<DocumentPageResult> = Vec::new();

    if extension == "pdf" {
        // Load the PDFium library the wizard downloaded into AppData rather than a
        // system copy — neither Windows nor macOS ships one. bind_to_library takes
        // the full path to the shared library, so it resolves regardless of the
        // process's library search path.
        let pdfium_lib = data_dir.join("binaries").join(pdfium_lib_name());
        if !pdfium_lib.exists() {
            return Err(format!(
                "PDFium library not found at {}. Re-run setup to reinstall it.",
                pdfium_lib.display()
            ));
        }
        let pdfium = Pdfium::new(
            Pdfium::bind_to_library(&pdfium_lib)
                .map_err(|error| format!("failed to bind to pdfium at {}: {error}", pdfium_lib.display()))?,
        );

        let document = pdfium
            .load_pdf_from_file(source_path, None)
            .map_err(|error| format!("failed to open pdf: {error}"))?;

        let render_config = PdfRenderConfig::new()
            .set_target_width(2000)
            .use_print_quality(true);

        let page_count = document.pages().len();

        for i in 0..page_count {
            let page = document
                .pages()
                .get(i)
                .map_err(|error| format!("failed to read page {}: {error}", i + 1))?;

            let bitmap = page
                .render_with_config(&render_config)
                .map_err(|error| format!("failed to render page {}: {error}", i + 1))?;

            let natural_width = bitmap.width() as i32;
            let natural_height = bitmap.height() as i32;

            let generated_path = session_dir.join(format!("{}_page_{}_{}.png", session_id, i + 1, timestamp));
            bitmap
                .as_image()
                .save(&generated_path)
                .map_err(|error| format!("failed to save page {}: {error}", i + 1))?;

            pages.push(ocr_image_to_page(
                &generated_path,
                natural_width,
                natural_height,
                &session_dir,
                false, // already high-res from pdfium; do not upscale
            )?);
        }

    } else if ["png", "jpg", "jpeg"].contains(&extension.as_str()) {
        let (natural_width, natural_height) = image::image_dimensions(source_path)
            .map(|(w, h)| (w as i32, h as i32))
            .unwrap_or((0, 0));

        pages.push(ocr_image_to_page(
            source_path,
            natural_width,
            natural_height,
            &session_dir,
            true, // arbitrary resolution; upscale if small
        )?);

    } else {
        return Err(format!("Unsupported file format: .{}", extension));
    }

    Ok(ExtractionResult { session_id, pages })
}

/// Prepend the bundled Tesseract dir to PATH and point TESSDATA_PREFIX at its
/// `tessdata` folder so OCR (which invokes a bare `tesseract` binary) resolves
/// the right executable and language data.
///
/// Idempotent. Must run before every OCR call rather than only at startup: when
/// Tesseract is installed by the first-run wizard, the `tesseract` dir does not
/// exist yet when the startup hook fires, so without this the env stays unset
/// until the app is restarted and the first OCR silently fails.
///
/// Note: this Tesseract 5.x build requires TESSDATA_PREFIX to point *directly at*
/// the tessdata folder — pointing it at the parent dir makes tesseract exit
/// non-zero with no output.
pub fn configure_tesseract_env(data_dir: &Path) {
    let dir = data_dir.join("tesseract");
    if !dir.exists() {
        return;
    }
    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
    let dir_str = dir.display().to_string();
    let current = std::env::var("PATH").unwrap_or_default();
    if !current.split(sep).any(|p| p == dir_str) {
        std::env::set_var("PATH", format!("{dir_str}{sep}{current}"));
    }
    std::env::set_var("TESSDATA_PREFIX", dir.join("tessdata").display().to_string());
}

/// Guarantee the `tsv` output config exists.
///
/// rusty-tesseract requests TSV by passing the *config file name* `tsv` to the
/// tesseract CLI; the engine resolves it at `<tessdata>/configs/tsv` (a one-line
/// file: `tessedit_create_tsv 1`). Some Tesseract packages omit the `configs/`
/// directory entirely — then tesseract logs "read_params_file: Can't open tsv"
/// and silently falls back to plain-text output, which fails our TSV parser with
/// "Could not parse invalid line". We depend on exactly this one config, so write
/// it ourselves when missing rather than trusting every package to include it.
/// Idempotent; safe to call before each OCR run.
fn ensure_tesseract_tsv_config(data_dir: &Path) {
    let configs_dir = data_dir.join("tesseract").join("tessdata").join("configs");
    let tsv = configs_dir.join("tsv");
    if tsv.exists() {
        return;
    }
    if fs::create_dir_all(&configs_dir).is_ok() {
        let _ = fs::write(&tsv, "tessedit_create_tsv 1\n");
    }
}
