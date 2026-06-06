use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{Manager, WindowEvent};

use serde::{Deserialize, Serialize};

use pdfium_render::prelude::*;

use image::{DynamicImage, GenericImageView, GrayImage, Luma};
use imageproc::contrast::adaptive_threshold;
use imageproc::filter::median_filter;

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
const ADAPTIVE_BLOCK_RADIUS: u32 = 12;
const DENOISE_RADIUS: u32 = 1;
const LINE_LENGTH_FRACTION: f32 = 0.5;
const MIN_RUN_TO_CONSIDER: u32 = 20;

fn remove_rule_lines(img: &mut GrayImage) {
    let (w, h) = (img.width(), img.height());
    let min_h_len = ((w as f32) * LINE_LENGTH_FRACTION) as u32;
    let min_v_len = ((h as f32) * LINE_LENGTH_FRACTION) as u32;

    let mut to_clear: Vec<(u32, u32)> = Vec::new();

    let is_black = |img: &GrayImage, x: u32, y: u32| img.get_pixel(x, y).0[0] < 128;

    for y in 0..h {
        let mut run_start = 0u32;
        let mut run_len = 0u32;
        for x in 0..w {
            if is_black(img, x, y) {
                if run_len == 0 { run_start = x; }
                run_len += 1;
            } else {
                if run_len >= min_h_len && run_len >= MIN_RUN_TO_CONSIDER {
                    for rx in run_start..(run_start + run_len) { to_clear.push((rx, y)); }
                }
                run_len = 0;
            }
        }
        if run_len >= min_h_len && run_len >= MIN_RUN_TO_CONSIDER {
            for rx in run_start..(run_start + run_len) { to_clear.push((rx, y)); }
        }
    }

    for x in 0..w {
        let mut run_start = 0u32;
        let mut run_len = 0u32;
        for y in 0..h {
            if is_black(img, x, y) {
                if run_len == 0 { run_start = y; }
                run_len += 1;
            } else {
                if run_len >= min_v_len && run_len >= MIN_RUN_TO_CONSIDER {
                    for ry in run_start..(run_start + run_len) { to_clear.push((x, ry)); }
                }
                run_len = 0;
            }
        }
        if run_len >= min_v_len && run_len >= MIN_RUN_TO_CONSIDER {
            for ry in run_start..(run_start + run_len) { to_clear.push((x, ry)); }
        }
    }

    for (x, y) in to_clear {
        img.put_pixel(x, y, Luma([255]));
    }
}

/// Produce a binarized, denoised, line-removed copy of `source` for Tesseract.
/// Returns (preprocessed_path, scale_factor). The scale factor is 1.0 unless
/// the image was upscaled; callers must divide OCR boxes by it to get original-space coords.
fn preprocess_for_ocr(
    source: &Path,
    out_dir: &Path,
    allow_upscale: bool,
) -> Result<(PathBuf, f32), String> {
    let img = image::open(source)
        .map_err(|e| format!("failed to open image for preprocessing: {e}"))?;

    let (w, h) = img.dimensions();
    let scale: f32 = if allow_upscale && w.min(h) < UPSCALE_NARROW_SIDE_THRESHOLD {
        2.0
    } else {
        1.0
    };
    let img = if scale != 1.0 {
        img.resize(
            (w as f32 * scale) as u32,
            (h as f32 * scale) as u32,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img
    };

    let gray: GrayImage = img.grayscale().to_luma8();
    let denoised = median_filter(&gray, DENOISE_RADIUS, DENOISE_RADIUS);
    let mut binary = adaptive_threshold(&denoised, ADAPTIVE_BLOCK_RADIUS);
    remove_rule_lines(&mut binary);

    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("page");
    let out_path = out_dir.join(format!("{stem}_ocr.png"));
    DynamicImage::ImageLuma8(binary)
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
async fn process_document(
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
        let pdfium = Pdfium::new(
            Pdfium::bind_to_system_library()
                .map_err(|error| format!("failed to bind to pdfium: {error}"))?,
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





// ------------------ Llama Server Management ------------------

const MAX_FILE_SIZE_BYTES: u64 = 500 * 1024 * 1024; // 500 MB

const DEFAULT_CTX_SIZE: &str = "8192";
const DEFAULT_IMAGE_MIN_TOKENS: &str = "1024";

struct AppState {
    llama_server: Mutex<Option<Child>>,
}

fn stop_llama_server_process(state: &AppState) -> Result<(), String> {
    let mut llama_server = state
        .llama_server
        .lock()
        .map_err(|error| format!("failed to lock llama server state: {error}"))?;

    if let Some(mut child) = llama_server.take() {
        child
            .kill()
            .map_err(|error| format!("failed to stop llama server: {error}"))?;

        let _ = child.wait();
    }

    Ok(())
}

#[tauri::command]
fn resolve_llama_server_path() -> Result<String, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let debug_binaries_dir = manifest_dir.join("target").join("debug").join("binaries");
    let source_binaries_dir = manifest_dir.join("binaries");

    let candidate_names: &[&str] = if cfg!(target_os = "windows") {
        &[
            "windows/llama-server.exe",
            "llama-server.exe",
        ]
    } else if cfg!(target_os = "macos") {
        &[
            "macos/llama-server-aarch64-apple-darwin",
            "llama-server-aarch64-apple-darwin",
        ]
    } else {
        &[
            "linux/llama-server",
            "llama-server",
        ]
    };

    let search_roots = [debug_binaries_dir, source_binaries_dir];

    for root in search_roots {
        for candidate_name in candidate_names {
            let candidate_path = root.join(candidate_name);

            if candidate_path.exists() {
                return Ok(candidate_path.to_string_lossy().into_owned());
            }
        }
    }

    Err(format!(
        "Unable to locate llama server binary. Searched: {}",
        candidate_names.join(", ")
    ))
}

#[tauri::command]
fn start_llama_server(
    state: tauri::State<'_, AppState>,
    model_path: String,
    mmproj_path: String,
    llama_server_path: String,
) -> Result<u32, String> {
    let mut llama_server = state
        .llama_server
        .lock()
        .map_err(|error| format!("failed to lock llama server state: {error}"))?;

    if let Some(child) = llama_server.as_mut() {
        if child
            .try_wait()
            .map_err(|error| format!("failed to inspect llama server state: {error}"))?
            .is_none()
        {
            return Ok(child.id());
        }

        llama_server.take();
    }

    let mut command = Command::new(&llama_server_path);
    command
        .arg("-m")
        .arg(model_path)
        .arg("--mmproj")
        .arg(mmproj_path)
        .arg("--image-min-tokens")
        .arg(DEFAULT_IMAGE_MIN_TOKENS)
        .arg("--port")
        .arg("8080")
        .arg("-c")
        .arg(DEFAULT_CTX_SIZE);

    let child = command
        .spawn()
        .map_err(|error| format!("failed to spawn llama server: {error}"))?;

    let pid = child.id();
    *llama_server = Some(child);

    Ok(pid)
}

#[tauri::command]
fn stop_llama_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    stop_llama_server_process(&state)
}



// ------------------------------------------------------


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 1. Resolve the path to our bundled Tesseract folder
            if let Ok(tesseract_dir) = app.path().resolve("resources/tesseract", tauri::path::BaseDirectory::Resource) {
                
                // 2. Add the bundled folder to the process PATH so rusty-tesseract can find tesseract.exe
                let current_path = std::env::var("PATH").unwrap_or_default();
                std::env::set_var("PATH", format!("{};{}", tesseract_dir.display(), current_path));

                // 3. Set TESSDATA_PREFIX so the engine knows exactly where the language models are
                let tessdata_dir = tesseract_dir.join("tessdata");
                std::env::set_var("TESSDATA_PREFIX", tessdata_dir.display().to_string());
                
                println!("Successfully injected bundled Tesseract into environment!");
            }
            Ok(())
        })
        .manage(AppState {
            llama_server: Mutex::new(None),
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let _ = stop_llama_server_process(&state);
                }
            }
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![resolve_llama_server_path, start_llama_server, stop_llama_server, process_document])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
