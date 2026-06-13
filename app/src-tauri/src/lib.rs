use std::{
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{Manager, WindowEvent};

use serde::{Deserialize, Serialize};

use pdfium_render::prelude::*;

use image::{DynamicImage, GenericImageView, GrayImage};

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
/// Pipeline: grayscale → Lanczos upscale (if narrow side < threshold) → save.
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





// ------------------ Llama Server Management ------------------

const MAX_FILE_SIZE_BYTES: u64 = 500 * 1024 * 1024; // 500 MB

const DEFAULT_CTX_SIZE: &str = "8192";
const DEFAULT_IMAGE_MIN_TOKENS: &str = "1024";
const DEFAULT_N_PARALLEL: &str = "1";

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
fn resolve_llama_server_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let binary = resolve_data_dir(&app_handle).join("binaries").join(llama_exe_name());
    if binary.exists() {
        Ok(binary.to_string_lossy().into_owned())
    } else {
        Err("llama-server not found — run the setup wizard to download it.".into())
    }
}

#[tauri::command]
fn start_llama_server(
    state: tauri::State<'_, AppState>,
    model_path: String,
    mmproj_path: String,
    llama_server_path: String,
    backend: String,
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

    let gpu_layers = match backend.as_str() {
        "cuda" | "rocm" | "metal" => "999",
        _ => "0",
    };

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
        .arg(DEFAULT_CTX_SIZE)
        .arg("--n-gpu-layers")
        .arg(gpu_layers)
        .arg("--parallel")
        .arg(DEFAULT_N_PARALLEL);

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



// ─────────────────────────────────────────────────────────────────────────────
// Setup / first-run dependency management
// ─────────────────────────────────────────────────────────────────────────────

// R2 bucket base URL
const R2_BASE: &str = "https://artifact-assets.aidenpaleczny.com";

// HuggingFace fallback URLs — update with the exact repo/file paths.
const HF_MODEL_URL: &str =
    "https://huggingface.co/PLACEHOLDER/resolve/main/Qwen3.5-4B-Q4_K_M.gguf";
const HF_MMPROJ_URL: &str =
    "https://huggingface.co/PLACEHOLDER/resolve/main/mmproj-F16.gguf";

fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve AppData directory")
}

const MODEL_FILENAME: &str = "Qwen3.5-4B-Q4_K_M.gguf";
const MMPROJ_FILENAME: &str = "mmproj-F16.gguf";

fn llama_exe_name() -> &'static str {
    if cfg!(target_os = "windows") { "llama-server.exe" } else { "llama-server" }
}

fn tesseract_exe_name() -> &'static str {
    if cfg!(target_os = "windows") { "tesseract.exe" } else { "tesseract" }
}

/// Filename of the PDFium shared library once extracted into the binaries dir.
/// Also used as the archive's flatten marker, since the library file is what we
/// lift out of the archive's wrapper folder.
fn pdfium_lib_name() -> &'static str {
    if cfg!(target_os = "windows") { "pdfium.dll" } else { "libpdfium.dylib" }
}

/// (r2_object_key, sha256_of_archive, approx_size_bytes) for the current
/// platform's prebuilt PDFium, or None on platforms we don't ship one for.
/// pdfium-render binds to a system pdfium at runtime; neither Windows nor macOS
/// has one, so we provide the upstream build. The Windows archive nests the lib
/// under bin/, the macOS one under lib/ — flatten_marker normalizes both.
fn pdfium_spec() -> Option<(&'static str, &'static str, u64)> {
    if cfg!(target_os = "windows") {
        return Some((
            "pdfium-win-x64.tgz",
            "b904e3898f952984fb744e0c8eb36512b5ee527124796108ed419a5b4da3c6d9",
            3_600_000,
        ));
    }
    if cfg!(target_os = "macos") {
        return Some((
            "pdfium-mac-arm64.tgz",
            "52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40",
            3_400_000,
        ));
    }
    None
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
fn configure_tesseract_env(data_dir: &Path) {
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

/// True if `dir` contains at least one entry whose filename starts with `prefix`.
fn dir_contains_prefix(dir: &Path, prefix: &str) -> bool {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.file_name().to_str().is_some_and(|n| n.starts_with(prefix))
            })
        })
        .unwrap_or(false)
}

/// Whether the final installed artifact(s) for a given manifest asset already
/// exist in AppData. Drives partial-install detection: the wizard skips assets
/// the user already has rather than re-downloading them. The checks target the
/// *extracted* result (not the archive, which is deleted after extraction).
fn asset_installed(asset_id: &str, data_dir: &Path) -> bool {
    let binaries = data_dir.join("binaries");
    let models = data_dir.join("models");
    let tesseract = data_dir.join("tesseract");
    match asset_id {
        "llama_server" => binaries.join(llama_exe_name()).exists(),
        // CUDA runtime DLLs are version-named (cudart64_12.dll / _13.dll) — match by prefix.
        "cudart" => dir_contains_prefix(&binaries, "cudart64"),
        "pdfium" => binaries.join(pdfium_lib_name()).exists(),
        "tesseract" => {
            tesseract.join(tesseract_exe_name()).exists()
                && tesseract.join("tessdata").join("eng.traineddata").exists()
        }
        "mmproj_gguf" => models.join(MMPROJ_FILENAME).exists(),
        "model_gguf" => models.join(MODEL_FILENAME).exists(),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// check_setup_complete
// ---------------------------------------------------------------------------

#[tauri::command]
fn check_setup_complete(app_handle: tauri::AppHandle) -> bool {
    let data_dir = resolve_data_dir(&app_handle);
    // cudart is intentionally excluded: it's only needed for the CUDA backend,
    // so requiring it would wrongly block CPU/Metal users.
    let mut required = vec!["llama_server", "tesseract", "mmproj_gguf", "model_gguf"];
    // pdfium is required wherever we ship one (Windows + macOS) — PDF rendering
    // depends on it. Gated on pdfium_spec so platforms without an asset (Linux)
    // aren't blocked on a file that never downloads.
    if pdfium_spec().is_some() {
        required.push("pdfium");
    }
    required.iter().all(|id| asset_installed(id, &data_dir))
}

// ---------------------------------------------------------------------------
// detect_hardware
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct HardwareInfo {
    pub gpu_name: Option<String>,
    pub gpu_vendor: Option<String>,
    pub vram_mb: Option<u64>,
    pub ram_mb: u64,
    pub recommended_backend: String,
}

#[tauri::command]
fn detect_hardware() -> HardwareInfo {
    let (gpu_name, gpu_vendor, vram_mb, ram_mb) = query_hardware();
    let recommended_backend = recommend_backend(gpu_vendor.as_deref(), vram_mb);
    HardwareInfo { gpu_name, gpu_vendor, vram_mb, ram_mb, recommended_backend }
}

fn recommend_backend(vendor: Option<&str>, vram_mb: Option<u64>) -> String {
    let v = match vendor { Some(s) => s, None => return "cpu".into() };
    if v.contains("NVIDIA") && vram_mb.unwrap_or(0) >= 4096 {
        return "cuda".into();
    }
    if v.contains("AMD") {
        #[cfg(target_os = "linux")]
        return "rocm".into();
    }
    if v.contains("Apple") {
        return "metal".into();
    }
    "cpu".into()
}

fn extract_gpu_vendor(name: &str) -> &'static str {
    let u = name.to_uppercase();
    if u.contains("NVIDIA") { "NVIDIA" }
    else if u.contains("AMD") || u.contains("RADEON") { "AMD" }
    else if u.contains("APPLE") { "Apple" }
    else if u.contains("INTEL") { "Intel" }
    else { "Unknown" }
}

fn query_hardware() -> (Option<String>, Option<String>, Option<u64>, u64) {
    #[cfg(target_os = "windows")]
    return query_hardware_windows();

    #[cfg(target_os = "macos")]
    return query_hardware_macos();

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return query_hardware_linux();

    #[allow(unreachable_code)]
    (None, None, None, 0)
}

#[cfg(target_os = "windows")]
fn query_hardware_windows() -> (Option<String>, Option<String>, Option<u64>, u64) {
    let ps_gpu = r#"try { $g = Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 } | Sort-Object AdapterRAM -Descending | Select-Object -First 1; if ($g) { [pscustomobject]@{ Name=$g.Name; VRAM=$g.AdapterRAM } | ConvertTo-Json -Compress } else { '{}' } } catch { '{}' }"#;
    let ps_ram = r#"try { [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB) } catch { 0 }"#;

    let gpu_json = run_powershell(ps_gpu).unwrap_or_default();
    let gpu_val: serde_json::Value = serde_json::from_str(gpu_json.trim()).unwrap_or_default();
    let gpu_name = gpu_val["Name"].as_str().map(String::from);
    let vram_mb = gpu_val["VRAM"].as_u64().map(|b| b / (1024 * 1024));
    let gpu_vendor = gpu_name.as_deref().map(extract_gpu_vendor).map(String::from);

    let ram_mb = run_powershell(ps_ram)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);

    (gpu_name, gpu_vendor, vram_mb, ram_mb)
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Option<String> {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn query_hardware_macos() -> (Option<String>, Option<String>, Option<u64>, u64) {
    let sp = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    let val: serde_json::Value = serde_json::from_str(&sp).unwrap_or_default();
    let gpu_name = val["SPDisplaysDataType"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|g| g["_name"].as_str())
        .map(String::from);
    let vram_mb = val["SPDisplaysDataType"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|g| g["spdisplays_vram"].as_str())
        .and_then(|s| s.split_whitespace().next())
        .and_then(|n| n.parse::<u64>().ok());

    let ram_bytes = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
        .unwrap_or(0);

    let gpu_vendor = gpu_name.as_deref().map(extract_gpu_vendor).map(String::from);
    (gpu_name, gpu_vendor, vram_mb, ram_bytes / (1024 * 1024))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn query_hardware_linux() -> (Option<String>, Option<String>, Option<u64>, u64) {
    let lspci = Command::new("lspci")
        .args(["-mm", "-d", "::0300"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    let gpu_line = lspci.lines().next().map(String::from);
    let gpu_vendor = gpu_line.as_deref().map(|l| {
        if l.contains("NVIDIA") { "NVIDIA" }
        else if l.contains("AMD") || l.contains("Advanced Micro Devices") { "AMD" }
        else if l.contains("Intel") { "Intel" }
        else { "Unknown" }
    }).map(String::from);

    let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let ram_mb = meminfo.lines()
        .find(|l| l.starts_with("MemTotal:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|n| n.parse::<u64>().ok())
        .map(|kb| kb / 1024)
        .unwrap_or(0);

    (gpu_line, gpu_vendor, None, ram_mb)
}

// ---------------------------------------------------------------------------
// download_file  (streams to a .part file; renames on completion)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct DownloadProgress {
    asset_id: String,
    bytes_received: u64,
    total_bytes: Option<u64>,
}

/// How many times to (re)connect for a single download before giving up and
/// letting the caller fall back to a different URL. Each retry resumes from the
/// bytes already on disk rather than restarting.
const DOWNLOAD_MAX_ATTEMPTS: u32 = 5;

/// Total object size from a 206 response's `Content-Range: bytes a-b/total`.
/// Returns None if the header is missing or the total is unknown (`*`).
fn parse_content_range_total(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?
        .rsplit('/')
        .next()?
        .trim()
        .parse::<u64>()
        .ok()
}

/// Delete a leftover `.part` for `dest_path`. The frontend calls this before
/// retrying a download from a *different* URL (primary → fallback), since the
/// two sources are distinct origins and resuming one stream into the other's
/// bytes would corrupt the file.
#[tauri::command]
fn clear_partial_download(dest_path: String) -> Result<(), String> {
    let part_path = PathBuf::from(format!("{dest_path}.part"));
    match fs::remove_file(&part_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to clear partial download: {e}")),
    }
}

#[tauri::command]
async fn download_file(
    app_handle: tauri::AppHandle,
    url: String,
    dest_path: String,
    asset_id: String,
) -> Result<(), String> {
    use tauri::Emitter;

    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }

    let part_path = PathBuf::from(format!("{dest_path}.part"));

    let client = reqwest::Client::builder()
        .user_agent("artifact-setup/1.0")
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let mut last_err = String::new();

    // Reconnect-and-resume loop: a transient drop mid-stream (common on a single
    // multi-GB GET) no longer fails the whole download — we resume from the bytes
    // already in `.part` via an HTTP Range request. Only a genuine HTTP error
    // (404/403/5xx) returns immediately so the caller can try the fallback URL.
    for attempt in 1..=DOWNLOAD_MAX_ATTEMPTS {
        let resume_from = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);

        let mut request = client.get(&url);
        if resume_from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }

        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("request failed: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(2 * attempt as u64)).await;
                continue;
            }
        };

        let status = response.status();

        // The `.part` is already >= the full object — nothing left to fetch.
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && resume_from > 0 {
            drop(response);
            fs::rename(&part_path, &dest).map_err(|e| format!("rename failed: {e}"))?;
            return Ok(());
        }

        if !status.is_success() {
            // Origin-level error; retrying the same URL won't help. Surface it so
            // the caller falls back to the alternate source.
            return Err(format!("HTTP {status} for {url}"));
        }

        // 206 → server honored Range, append. 200 → it ignored Range (or we had
        // nothing to resume), so (re)start from zero.
        let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT && resume_from > 0;

        let total_bytes = if resuming {
            parse_content_range_total(&response)
                .or_else(|| response.content_length().map(|l| l + resume_from))
        } else {
            response.content_length()
        };

        let mut file = if resuming {
            std::fs::OpenOptions::new()
                .append(true)
                .open(&part_path)
                .map_err(|e| format!("open .part for resume failed: {e}"))?
        } else {
            std::fs::File::create(&part_path)
                .map_err(|e| format!("create .part file failed: {e}"))?
        };

        let mut bytes_received: u64 = if resuming { resume_from } else { 0 };
        let mut stream = response;
        let mut stream_failed = false;

        loop {
            match stream.chunk().await {
                Ok(Some(chunk)) => {
                    file.write_all(&chunk).map_err(|e| format!("write error: {e}"))?;
                    bytes_received += chunk.len() as u64;
                    let _ = app_handle.emit("setup:progress", DownloadProgress {
                        asset_id: asset_id.clone(),
                        bytes_received,
                        total_bytes,
                    });
                }
                Ok(None) => break, // stream finished cleanly
                Err(e) => {
                    last_err = format!("stream error: {e}");
                    stream_failed = true;
                    break;
                }
            }
        }

        drop(file);

        if stream_failed {
            // Bytes received so far are preserved in `.part`; back off and resume.
            tokio::time::sleep(std::time::Duration::from_secs(2 * attempt as u64)).await;
            continue;
        }

        fs::rename(&part_path, &dest).map_err(|e| format!("rename failed: {e}"))?;
        return Ok(());
    }

    Err(format!("download failed after {DOWNLOAD_MAX_ATTEMPTS} attempts: {last_err}"))
}

// ---------------------------------------------------------------------------
// verify_file_hash
// ---------------------------------------------------------------------------

#[tauri::command]
fn verify_file_hash(path: String, expected_sha256: String) -> Result<bool, String> {
    use sha2::{Digest, Sha256};

    // An empty expected hash means the asset hasn't been pinned yet. Running an
    // unverified binary in a shipped build is unacceptable, so fail closed in
    // release. Debug builds skip with a warning so development against not-yet-pinned
    // R2 objects isn't blocked.
    if expected_sha256.is_empty() {
        if cfg!(debug_assertions) {
            eprintln!("WARNING: no pinned sha256 for {path}; skipping verification (debug build only)");
            return Ok(true);
        }
        return Err(format!(
            "no pinned sha256 for {path}; refusing to accept an unverified asset in a release build"
        ));
    }

    let mut file = std::fs::File::open(&path)
        .map_err(|e| format!("open failed: {e}"))?;

    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read error: {e}"))?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }

    let actual = format!("{:x}", hasher.finalize());
    Ok(actual.eq_ignore_ascii_case(&expected_sha256))
}

// ---------------------------------------------------------------------------
// extract_archive
//
// Handles both .zip (Windows/Linux llama.cpp + Tesseract) and .tar.gz (macOS
// llama.cpp) so the unmodified upstream release archive can be dropped into R2.
//
// `flatten_marker`: upstream archives wrap their payload in an inconsistent
// directory layout — the macOS llama tarball nests binaries under `build/bin/`,
// and the Tesseract installer zip wraps everything in a `tesseract-w64/` folder,
// while the Windows llama zips are flat. When a marker is given (e.g.
// `llama-server` or `tesseract`), we extract to a staging dir, find the directory
// that actually contains the marker binary at any depth, and copy that directory's
// whole subtree into `dest_dir`. This normalizes every layout: the binary (and
// any sibling dirs it needs, like Tesseract's `tessdata/`) land directly in
// `dest_dir`, regardless of how many wrapper folders the archive added.
// ---------------------------------------------------------------------------

fn is_targz(path: &str) -> bool {
    let p = path.to_lowercase();
    p.ends_with(".tar.gz") || p.ends_with(".tgz")
}

/// Extract an archive into `dest`, preserving its internal directory structure.
fn extract_preserving(archive_path: &str, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("mkdir failed: {e}"))?;

    if is_targz(archive_path) {
        let file = fs::File::open(archive_path)
            .map_err(|e| format!("open archive failed: {e}"))?;
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        // unpack() preserves permissions (incl. the executable bit) and rejects
        // entries that would escape `dest` via path traversal.
        archive.unpack(dest).map_err(|e| format!("tar.gz extract failed: {e}"))?;
        return Ok(());
    }

    use zip::ZipArchive;
    let file = fs::File::open(archive_path)
        .map_err(|e| format!("open archive failed: {e}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("zip open failed: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("zip entry error at index {i}: {e}"))?;

        // enclosed_name() returns None for entries with path traversal — skip them.
        let Some(out_path) = entry.enclosed_name().map(|n| dest.join(n)) else {
            continue;
        };

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("mkdir failed: {e}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
            }
            let mut out_file = fs::File::create(&out_path)
                .map_err(|e| format!("create file failed: {e}"))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("extract failed: {e}"))?;

            // Preserve the executable bit (llama-server in upstream zips).
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(mode));
            }
        }
    }

    Ok(())
}

/// Find the directory that contains a file named `marker` or `marker.exe`
/// anywhere under `root`. Used to locate the real payload root inside an archive
/// that may have wrapped it in one or more enclosing folders.
fn find_marker_dir(root: &Path, marker: &str) -> Option<PathBuf> {
    let marker_exe = format!("{marker}.exe");
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else { continue };
        let mut subdirs = Vec::new();
        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_dir() {
                subdirs.push(path);
            } else if matches!(
                path.file_name().and_then(|n| n.to_str()),
                Some(name) if name == marker || name == marker_exe
            ) {
                return Some(dir);
            }
        }
        stack.extend(subdirs);
    }
    None
}

/// Recursively copy the contents of `src` into `dest`, preserving subdirectories
/// (e.g. Tesseract's `tessdata/`). `fs::copy` carries permission bits on unix,
/// so the executable bit on binaries is retained.
fn copy_dir_contents(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("mkdir failed: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read dir failed: {e}"))? {
        let path = entry.map_err(|e| format!("read dir failed: {e}"))?.path();
        let Some(name) = path.file_name() else { continue };
        let target = dest.join(name);
        if path.is_dir() {
            copy_dir_contents(&path, &target)?;
        } else {
            // Remove any existing target first. Release binaries (e.g. Tesseract)
            // ship as mode 0o555 — no owner write bit — so fs::copy onto an existing
            // copy from a previous run fails to truncate it with EACCES
            // ("Permission denied, os error 13"). Deleting first makes re-extraction
            // idempotent regardless of the source file's permissions.
            let _ = fs::remove_file(&target);
            fs::copy(&path, &target).map_err(|e| format!("copy failed: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn extract_archive(
    archive_path: String,
    dest_dir: String,
    flatten_marker: Option<String>,
) -> Result<(), String> {
    let dest = Path::new(&dest_dir);

    if let Some(marker) = flatten_marker {
        // Stage alongside the archive, locate the real payload root, then lift it up.
        let staging = PathBuf::from(format!("{archive_path}.extract"));
        let _ = fs::remove_dir_all(&staging); // clear any stale staging dir
        extract_preserving(&archive_path, &staging)?;

        let root = find_marker_dir(&staging, &marker)
            .ok_or_else(|| format!("'{marker}' not found inside archive"))?;

        copy_dir_contents(&root, dest)?;
        let _ = fs::remove_dir_all(&staging);
    } else {
        extract_preserving(&archive_path, dest)?;
    }

    fs::remove_file(&archive_path).ok();
    Ok(())
}

// ---------------------------------------------------------------------------
// get_setup_paths
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SetupPaths {
    pub llama_server: String,
    pub model_path: String,
    pub mmproj_path: String,
}

#[tauri::command]
fn get_setup_paths(app_handle: tauri::AppHandle) -> SetupPaths {
    let d = resolve_data_dir(&app_handle);
    SetupPaths {
        llama_server: d.join("binaries").join(llama_exe_name()).to_string_lossy().into_owned(),
        model_path:   d.join("models").join(MODEL_FILENAME).to_string_lossy().into_owned(),
        mmproj_path:  d.join("models").join(MMPROJ_FILENAME).to_string_lossy().into_owned(),
    }
}

// ---------------------------------------------------------------------------
// get_asset_manifest
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct AssetManifestEntry {
    pub asset_id: String,
    pub label: String,
    pub size_bytes: u64,
    pub dest_path: String,
    pub sha256: String,
    pub url_primary: String,
    pub url_fallback: Option<String>,
    /// If set, the downloaded file is an archive (.zip or .tar.gz) extracted to this directory.
    pub extract_to_dir: Option<String>,
    /// When set, collapse any wrapper folders the archive added by locating the
    /// directory containing this marker binary (e.g. `llama-server`, `tesseract`)
    /// and copying its contents into `extract_to_dir`. When null, extract as-is.
    pub flatten_marker: Option<String>,
    /// True if this asset's final artifact already exists in AppData. The wizard
    /// uses this to skip re-downloading assets the user already has.
    pub installed: bool,
}

// llama.cpp release archives are uploaded to R2 as-is, under `binaries/`, with the
// build tag and CUDA version stripped from the filename. Examples:
//   llama-b9596-bin-win-cpu-x64.zip        → binaries/llama-bin-win-cpu-x64.zip
//   llama-b9550-bin-win-cuda-13.3-x64.zip  → binaries/llama-bin-win-cuda-x64.zip
//   cudart-llama-bin-win-cuda-13.3-x64.zip → binaries/cudart-llama-bin-win-cuda-x64.zip
//   llama-b9596-bin-macos-arm64.tar.gz     → binaries/llama-bin-macos-arm64.tar.gz
// Windows/Linux zips are flat; the macOS .tar.gz nests binaries under build/bin.
// extract_archive(flatten=true) normalizes both so llama-server[.exe] and its
// shared libraries end up directly in the `binaries` dir.
fn get_llama_server_spec(backend: &str) -> (&'static str, u64, &'static str, &'static str) {
    // (label, approx_size_bytes, r2_object_key, sha256_of_archive)
    // The hash pins the downloaded archive at dest_path (pre-extraction). Empty =
    // not yet uploaded to R2, so verify_file_hash skips it.
    if cfg!(target_os = "macos") {
        // macOS releases are .tar.gz (nested under build/bin) — see extract_archive.
        return ("llama.cpp server (Metal / Apple Silicon)", 50_000_000, "llama-bin-macos-arm64.tar.gz",
            "b77565f38c8cad9b0132dd4dbca54e201e8fb5b654d57780b87e0e05da25fafe");
    }
    if cfg!(target_os = "windows") {
        return if backend == "cuda" {
            ("llama.cpp server (CUDA / GPU)", 160_000_000, "llama-bin-win-cuda-x64.zip",
                "4be0993b63ff501e3aa23e7f35e16e03a8b44404462792994cd66ce98915fa7e")
        } else {
            ("llama.cpp server (CPU)", 17_000_000, "llama-bin-win-cpu-x64.zip",
                "d6af2cdf070fe3222c1ffc0cf9665d1d395aff32b985a29d8dc2e3ae1398d780")
        };
    }
    // Linux — upstream only publishes CPU (ubuntu) builds; GPU backends fall back to it.
    // Not yet uploaded to R2 — leave the hash empty until it is.
    ("llama.cpp server (CPU)", 25_000_000, "llama-bin-ubuntu-x64.zip", "")
}

fn get_tesseract_spec(data_dir: &Path) -> AssetManifestEntry {
    // sha256 pins the downloaded tesseract.zip (pre-extraction). Empty = not yet
    // uploaded to R2 (Linux), so verify_file_hash skips it.
    let (label, size_bytes, url_suffix, sha256) = if cfg!(target_os = "windows") {
        ("Tesseract OCR engine (90 MB)", 90_000_000u64, "windows/tesseract.zip",
            "268ded1253c5697071915e0dcea6c32a278bf037d51d0602165d4502c113dd1a")
    } else if cfg!(target_os = "macos") {
        ("Tesseract OCR engine (15 MB)", 15_000_000u64, "macos/tesseract.zip",
            "efe841cbccfa2f65664101546a93cc47a793dcf8b2313d47460ca234482430ab")
    } else {
        ("Tesseract OCR engine (15 MB)", 15_000_000u64, "linux/tesseract.zip", "")
    };

    AssetManifestEntry {
        asset_id:       "tesseract".into(),
        label:          label.into(),
        size_bytes,
        dest_path:      data_dir.join("tesseract.zip").to_string_lossy().into_owned(),
        sha256:         sha256.into(),
        url_primary:    format!("{R2_BASE}/{url_suffix}"),
        url_fallback:   None,
        extract_to_dir: Some(data_dir.join("tesseract").to_string_lossy().into_owned()),
        // Installer zips wrap files in a folder (e.g. tesseract-w64/); find the
        // real root by the tesseract binary. tessdata/ subtree is preserved.
        flatten_marker: Some("tesseract".into()),
        installed:      false, // filled in by get_asset_manifest
    }
}

#[tauri::command]
fn get_asset_manifest(app_handle: tauri::AppHandle, backend: String) -> Vec<AssetManifestEntry> {
    let data_dir = resolve_data_dir(&app_handle);
    let binaries_dir = data_dir.join("binaries").to_string_lossy().into_owned();
    let (label, size_bytes, r2_key, llama_sha) = get_llama_server_spec(&backend);

    // Keep the local archive's extension matching the upstream format so
    // extract_archive can dispatch zip vs tar.gz.
    let llama_archive = if is_targz(r2_key) { "llama.tar.gz" } else { "llama.zip" };

    let llama = AssetManifestEntry {
        asset_id:       "llama_server".into(),
        label:          label.into(),
        size_bytes,
        dest_path:      data_dir.join(llama_archive).to_string_lossy().into_owned(),
        sha256:         llama_sha.into(),
        url_primary:    format!("{R2_BASE}/binaries/{r2_key}"),
        url_fallback:   None,
        extract_to_dir: Some(binaries_dir.clone()),
        flatten_marker: Some("llama-server".into()), // macOS nests under build/bin; Windows is flat
        installed:      false,
    };

    // Windows CUDA builds need the CUDA runtime DLLs, which llama.cpp ships as a
    // separate zip. Its DLLs sit flat at the root, so a plain extract into the
    // binaries dir places them alongside llama-server.exe.
    let cudart = (cfg!(target_os = "windows") && backend == "cuda").then(|| AssetManifestEntry {
        asset_id:       "cudart".into(),
        label:          "CUDA runtime libraries".into(),
        size_bytes:     400_000_000,
        dest_path:      data_dir.join("cudart.zip").to_string_lossy().into_owned(),
        sha256:         String::new(),
        url_primary:    format!("{R2_BASE}/binaries/cudart-llama-bin-win-cuda-x64.zip"),
        url_fallback:   None,
        extract_to_dir: Some(binaries_dir.clone()),
        flatten_marker: None, // DLLs sit flat at the zip root
        installed:      false,
    });

    // PDFium renderer (Windows + macOS; see pdfium_spec). The library nests under
    // a wrapper folder in the archive, so flatten by its filename to drop it
    // directly into the binaries dir.
    let pdfium = pdfium_spec().map(|(key, sha, size)| AssetManifestEntry {
        asset_id:       "pdfium".into(),
        label:          "PDFium renderer".into(),
        size_bytes:     size,
        dest_path:      data_dir.join("pdfium.tgz").to_string_lossy().into_owned(),
        sha256:         sha.into(),
        url_primary:    format!("{R2_BASE}/binaries/{key}"),
        url_fallback:   None,
        extract_to_dir: Some(binaries_dir),
        flatten_marker: Some(pdfium_lib_name().into()),
        installed:      false,
    });

    let tesseract = get_tesseract_spec(&data_dir);

    let mmproj = AssetManifestEntry {
        asset_id:       "mmproj_gguf".into(),
        label:          "Vision projector (656 MB)".into(),
        size_bytes:     656_000_000,
        dest_path:      data_dir.join("models").join(MMPROJ_FILENAME).to_string_lossy().into_owned(),
        sha256:         "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864".into(),
        url_primary:    format!("{R2_BASE}/models/{MMPROJ_FILENAME}"),
        url_fallback:   Some(HF_MMPROJ_URL.into()),
        extract_to_dir: None,
        flatten_marker: None,
        installed:      false,
    };

    let model = AssetManifestEntry {
        asset_id:       "model_gguf".into(),
        label:          "Qwen language model (2.7 GB)".into(),
        size_bytes:     2_700_000_000,
        dest_path:      data_dir.join("models").join(MODEL_FILENAME).to_string_lossy().into_owned(),
        sha256:         "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4".into(),
        url_primary:    format!("{R2_BASE}/models/{MODEL_FILENAME}"),
        url_fallback:   Some(HF_MODEL_URL.into()),
        extract_to_dir: None,
        flatten_marker: None,
        installed:      false,
    };

    // Ordered smallest → largest so early progress is fast.
    let mut assets = vec![llama];
    assets.extend(cudart);
    assets.extend(pdfium);
    assets.extend([tesseract, mmproj, model]);

    // Flag assets whose final artifact is already on disk so the wizard can skip
    // re-downloading them (partial-install detection).
    for asset in &mut assets {
        asset.installed = asset_installed(&asset.asset_id, &data_dir);
    }
    assets
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Best-effort at startup; process_document re-runs this so OCR also
            // works when Tesseract is installed by the wizard mid-session.
            if let Ok(data_dir) = app.path().app_data_dir() {
                configure_tesseract_env(&data_dir);
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            // Document processing
            process_document,
            // Llama server
            resolve_llama_server_path, start_llama_server, stop_llama_server,
            // Setup wizard
            check_setup_complete, detect_hardware,
            download_file, clear_partial_download, verify_file_hash,
            get_setup_paths, get_asset_manifest, extract_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Validates extract_archive's flatten logic against a real pdfium archive:
    /// the upstream .tgz nests the shared library under bin/ (Windows) or lib/
    /// (macOS), and the flatten marker must lift it flat into the dest dir without
    /// dragging the wrapper folders (include/, etc.) along.
    ///
    /// Skipped unless PDFIUM_TGZ points at a downloaded pdfium archive, so a plain
    /// `cargo test` stays green without the asset. To run it:
    ///   PowerShell: $env:PDFIUM_TGZ="C:\path\to\pdfium-win-x64.tgz"
    ///              cargo test extract_pdfium_flattens_library -- --nocapture
    #[test]
    fn extract_pdfium_flattens_library() {
        let Ok(src) = std::env::var("PDFIUM_TGZ") else {
            eprintln!("PDFIUM_TGZ not set — skipping pdfium extract test");
            return;
        };

        // extract_archive deletes the archive on success, so operate on a copy.
        let work = std::env::temp_dir().join(format!("pdfium_extract_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&work);
        fs::create_dir_all(&work).expect("create work dir");
        let archive = work.join("pdfium.tgz");
        fs::copy(&src, &archive).expect("copy archive into work dir");

        let dest = work.join("binaries");
        let lib = pdfium_lib_name();

        extract_archive(
            archive.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
            Some(lib.to_string()),
        )
        .expect("extract_archive failed");

        // The library must land flat in dest…
        assert!(dest.join(lib).exists(), "{lib} did not land flat in {}", dest.display());
        // …with the wrapper dirs collapsed away (only the marker dir's contents copied).
        assert!(!dest.join("include").exists(), "wrapper dir 'include' leaked into dest");
        // asset_installed must now agree the asset is present.
        assert!(asset_installed("pdfium", &work), "asset_installed(pdfium) should be true");

        let _ = fs::remove_dir_all(&work);
    }
}
