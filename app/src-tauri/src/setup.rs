//! First-run dependency management.
//!
//! Drives the setup wizard: building the asset manifest, downloading assets
//! (with resume + fallback URLs), verifying SHA-256 hashes, extracting archives
//! (normalizing upstream's inconsistent wrapper-folder layouts), and detecting
//! which assets are already installed.

use std::{
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::paths::{
    llama_exe_name, pdfium_lib_name, pdfium_spec, resolve_data_dir, tesseract_exe_name,
    MMPROJ_FILENAME, MODEL_FILENAME,
};

// R2 bucket base URL
const R2_BASE: &str = "https://artifact-assets.aidenpaleczny.com";

// HuggingFace fallback URLs — update with the exact repo/file paths.
const HF_MODEL_URL: &str =
    "https://huggingface.co/PLACEHOLDER/resolve/main/Qwen3.5-4B-Q4_K_M.gguf";
const HF_MMPROJ_URL: &str =
    "https://huggingface.co/PLACEHOLDER/resolve/main/mmproj-F16.gguf";

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
pub fn check_setup_complete(app_handle: tauri::AppHandle) -> bool {
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
pub fn clear_partial_download(dest_path: String) -> Result<(), String> {
    let part_path = PathBuf::from(format!("{dest_path}.part"));
    match fs::remove_file(&part_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to clear partial download: {e}")),
    }
}

#[tauri::command]
pub async fn download_file(
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
pub fn verify_file_hash(path: String, expected_sha256: String) -> Result<bool, String> {
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
pub fn extract_archive(
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
pub fn get_setup_paths(app_handle: tauri::AppHandle) -> SetupPaths {
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
pub fn get_asset_manifest(app_handle: tauri::AppHandle, backend: String) -> Vec<AssetManifestEntry> {
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
