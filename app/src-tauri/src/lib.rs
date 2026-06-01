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

    // 1. Determine the file type
    let extension = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Save generated images inside the app data sessions folder so the asset protocol can read them.
    let session_dir = app_handle
        .path()
        .resolve("sessions", tauri::path::BaseDirectory::AppData)
        .map_err(|error| format!("failed to resolve output directory: {error}"))?;

    std::fs::create_dir_all(&session_dir)
        .map_err(|error| format!("failed to create output directory: {error}"))?;

    let target_image_path;
    let mut natural_width = 0;
    let mut natural_height = 0;

    // 2. Route based on file type
    if extension == "pdf" {
        // --- PDF PROCESSING ---
        let pdfium = Pdfium::new(
            Pdfium::bind_to_system_library()
                .map_err(|error| format!("failed to bind to pdfium: {error}"))?,
        );

        let document = pdfium
            .load_pdf_from_file(source_path, None)
            .map_err(|error| format!("failed to open pdf: {error}"))?;

        let page = document
            .pages()
            .first()
            .map_err(|error| format!("failed to read first page: {error}"))?;

        let render_config = PdfRenderConfig::new()
            .set_target_width(2000)
            .use_print_quality(true);

        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|error| format!("failed to render pdf page: {error}"))?;

        natural_width = bitmap.width() as i32;
        natural_height = bitmap.height() as i32;

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let generated_path = session_dir.join(format!("{}_page_1_{}.png", session_id, timestamp));
        bitmap
            .as_image()
            .save(&generated_path)
            .map_err(|error| format!("failed to save rendered image: {error}"))?;

        target_image_path = generated_path;

    } else if ["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
        // --- IMAGE PROCESSING ---
        // It's already an image, so we just use the original path!
        target_image_path = source_path.to_path_buf();
        
        // Optionally get dimensions if you need them for the frontend
        if let Ok(dimensions) = image::image_dimensions(&target_image_path) {
            natural_width = dimensions.0 as i32;
            natural_height = dimensions.1 as i32;
        }
    } else {
        return Err(format!("Unsupported file format: .{}", extension));
    }

    // 3. Run OCR on the resulting image
    let mut args = rusty_tesseract::Args::default();
    args.lang = "eng".to_string();

    let tesseract_image = rusty_tesseract::tesseract::input::Image::from_path(&target_image_path)
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
                left: item.left,
                top: item.top,
                width: item.width,
                height: item.height,
            },
        })
        .collect::<Vec<_>>();

    Ok(ExtractionResult {
        session_id,
        pages: vec![DocumentPageResult {
            image_path: target_image_path.to_string_lossy().into_owned(),
            natural_width,
            natural_height,
            words,
            text: ocr_output.output,
        }],
    })
}





// ------------------ Llama Server Management ------------------

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
