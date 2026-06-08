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

// R2 bucket base URL — update this once the bucket is provisioned.
const R2_BASE: &str = "https://r2.artifact-app.com";

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

fn llama_exe_name() -> &'static str {
    if cfg!(target_os = "windows") { "llama-server.exe" } else { "llama-server" }
}

fn tesseract_exe_name() -> &'static str {
    if cfg!(target_os = "windows") { "tesseract.exe" } else { "tesseract" }
}

// ---------------------------------------------------------------------------
// check_setup_complete
// ---------------------------------------------------------------------------

#[tauri::command]
fn check_setup_complete(app_handle: tauri::AppHandle) -> bool {
    let data_dir = resolve_data_dir(&app_handle);
    let required = [
        data_dir.join("binaries").join(llama_exe_name()),
        data_dir.join("tesseract").join(tesseract_exe_name()),
        data_dir.join("tesseract").join("tessdata").join("eng.traineddata"),
        data_dir.join("models").join("Qwen3.5-4B-Q4_K_M.gguf"),
        data_dir.join("models").join("mmproj-F16.gguf"),
    ];
    required.iter().all(|p| p.exists())
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

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {} for {url}", response.status()));
    }

    let total_bytes = response.content_length();
    let mut file = std::fs::File::create(&part_path)
        .map_err(|e| format!("create .part file failed: {e}"))?;

    let mut bytes_received: u64 = 0;
    let mut stream = response;

    while let Some(chunk) = stream.chunk().await.map_err(|e| format!("stream error: {e}"))? {
        file.write_all(&chunk).map_err(|e| format!("write error: {e}"))?;
        bytes_received += chunk.len() as u64;
        let _ = app_handle.emit("setup:progress", DownloadProgress {
            asset_id: asset_id.clone(),
            bytes_received,
            total_bytes,
        });
    }

    drop(file);
    fs::rename(&part_path, &dest).map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// verify_file_hash
// ---------------------------------------------------------------------------

#[tauri::command]
fn verify_file_hash(path: String, expected_sha256: String) -> Result<bool, String> {
    use sha2::{Digest, Sha256};

    // Empty hash = not yet pinned, skip verification.
    if expected_sha256.is_empty() {
        return Ok(true);
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
// extract_zip
// ---------------------------------------------------------------------------

#[tauri::command]
fn extract_zip(archive_path: String, dest_dir: String) -> Result<(), String> {
    use zip::ZipArchive;

    let dest = Path::new(&dest_dir);
    fs::create_dir_all(dest).map_err(|e| format!("mkdir failed: {e}"))?;

    let file = fs::File::open(&archive_path)
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
        }
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
        model_path:   d.join("models").join("Qwen3.5-4B-Q4_K_M.gguf").to_string_lossy().into_owned(),
        mmproj_path:  d.join("models").join("mmproj-F16.gguf").to_string_lossy().into_owned(),
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
    /// If set, the downloaded file is a zip that should be extracted to this directory.
    pub extract_to_dir: Option<String>,
}

fn get_llama_server_spec(backend: &str) -> (&'static str, &'static str, u64, &'static str) {
    // (filename, label, size_bytes, url_suffix)
    if cfg!(target_os = "macos") {
        return ("llama-server", "llama-server (Metal / Apple Silicon)", 46_000_000, "macos/llama-server");
    }
    if cfg!(target_os = "windows") {
        return if backend == "cuda" {
            ("llama-server.exe", "llama-server (CUDA / GPU)", 80_000_000, "windows/llama-server-cuda.exe")
        } else {
            ("llama-server.exe", "llama-server (CPU)", 46_000_000, "windows/llama-server-cpu.exe")
        };
    }
    // Linux
    match backend {
        "cuda" => ("llama-server", "llama-server (CUDA / GPU)", 80_000_000, "linux/llama-server-cuda"),
        "rocm" => ("llama-server", "llama-server (ROCm / AMD GPU)", 80_000_000, "linux/llama-server-rocm"),
        _      => ("llama-server", "llama-server (CPU)", 46_000_000, "linux/llama-server-cpu"),
    }
}

fn get_tesseract_spec(data_dir: &Path) -> AssetManifestEntry {
    let (label, size_bytes, url_suffix) = if cfg!(target_os = "windows") {
        ("Tesseract OCR engine (90 MB)", 90_000_000u64, "windows/tesseract.zip")
    } else if cfg!(target_os = "macos") {
        ("Tesseract OCR engine (15 MB)", 15_000_000u64, "macos/tesseract.zip")
    } else {
        ("Tesseract OCR engine (15 MB)", 15_000_000u64, "linux/tesseract.zip")
    };

    AssetManifestEntry {
        asset_id:       "tesseract".into(),
        label:          label.into(),
        size_bytes,
        dest_path:      data_dir.join("tesseract.zip").to_string_lossy().into_owned(),
        sha256:         String::new(),
        url_primary:    format!("{R2_BASE}/{url_suffix}"),
        url_fallback:   None,
        extract_to_dir: Some(data_dir.join("tesseract").to_string_lossy().into_owned()),
    }
}

#[tauri::command]
fn get_asset_manifest(app_handle: tauri::AppHandle, backend: String) -> Vec<AssetManifestEntry> {
    let data_dir = resolve_data_dir(&app_handle);
    let (filename, label, size_bytes, url_suffix) = get_llama_server_spec(&backend);

    let llama = AssetManifestEntry {
        asset_id:       "llama_server".into(),
        label:          label.into(),
        size_bytes,
        dest_path:      data_dir.join("binaries").join(filename).to_string_lossy().into_owned(),
        sha256:         String::new(),
        url_primary:    format!("{R2_BASE}/binaries/{url_suffix}"),
        url_fallback:   None,
        extract_to_dir: None,
    };

    let tesseract = get_tesseract_spec(&data_dir);

    let mmproj = AssetManifestEntry {
        asset_id:       "mmproj_gguf".into(),
        label:          "Vision projector (656 MB)".into(),
        size_bytes:     656_000_000,
        dest_path:      data_dir.join("models").join("mmproj-F16.gguf").to_string_lossy().into_owned(),
        sha256:         String::new(),
        url_primary:    format!("{R2_BASE}/models/mmproj-F16.gguf"),
        url_fallback:   Some(HF_MMPROJ_URL.into()),
        extract_to_dir: None,
    };

    let model = AssetManifestEntry {
        asset_id:       "model_gguf".into(),
        label:          "Qwen language model (2.7 GB)".into(),
        size_bytes:     2_700_000_000,
        dest_path:      data_dir.join("models").join("Qwen3.5-4B-Q4_K_M.gguf").to_string_lossy().into_owned(),
        sha256:         String::new(),
        url_primary:    format!("{R2_BASE}/models/Qwen3.5-4B-Q4_K_M.gguf"),
        url_fallback:   Some(HF_MODEL_URL.into()),
        extract_to_dir: None,
    };

    // Ordered smallest → largest so early progress is fast.
    vec![llama, tesseract, mmproj, model]
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let tesseract_dir = app
                .path()
                .app_data_dir()
                .map(|d| d.join("tesseract"))
                .ok()
                .filter(|p| p.exists());

            if let Some(dir) = tesseract_dir {
                let current_path = std::env::var("PATH").unwrap_or_default();
                let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
                std::env::set_var("PATH", format!("{}{}{}", dir.display(), sep, current_path));
                std::env::set_var("TESSDATA_PREFIX", dir.join("tessdata").display().to_string());
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
            download_file, verify_file_hash,
            get_setup_paths, get_asset_manifest, extract_zip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
