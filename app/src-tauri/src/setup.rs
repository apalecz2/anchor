//! First-run dependency management.
//!
//! Drives the setup wizard: building the asset manifest, downloading assets
//! (with resume + fallback URLs), verifying SHA-256 hashes, extracting archives
//! (normalizing upstream's inconsistent wrapper-folder layouts), and detecting
//! which assets are already installed.

use std::{
    fs,
    io::{Read as _, Seek as _, Write as _},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::paths::{
    llama_exe_name, pdfium_lib_name, pdfium_spec, resolve_data_dir, tesseract_exe_name,
    MMPROJ_FILENAME, MODEL_FILENAME,
};

// R2 bucket base URL
const R2_BASE: &str = "https://anchor-assets.aidenpaleczny.com";

// HuggingFace fallback URLs for the two GGUF models, used only if the R2 primary
// is unreachable. Pinned to an exact commit revision (not `main`) so the bytes
// can never change underneath the SHA-256 pins below — a re-quant pushed to `main`
// would otherwise make the fallback fail verification exactly when it is needed.
// Repo unsloth/Qwen3.5-4B-GGUF @ e87f176479d0855a907a41277aca2f8ee7a09523 is the
// same build whose digests are pinned in get_asset_manifest.
const HF_MODEL_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf";
const HF_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/mmproj-F16.gguf";

/// True if `dir` contains at least one entry whose filename starts with `prefix`.
fn dir_contains_prefix(dir: &Path, prefix: &str) -> bool {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with(prefix))
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
pub fn check_setup_complete(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let data_dir = resolve_data_dir(&app_handle)?;
    // cudart is intentionally excluded: it's only needed for the CUDA backend,
    // so requiring it would wrongly block CPU/Metal users.
    let mut required = vec!["llama_server", "tesseract", "mmproj_gguf", "model_gguf"];
    // pdfium is required wherever we ship one (Windows + macOS) — PDF rendering
    // depends on it. Gated on pdfium_spec so platforms without an asset (Linux)
    // aren't blocked on a file that never downloads.
    if pdfium_spec().is_some() {
        required.push("pdfium");
    }
    Ok(required.iter().all(|id| asset_installed(id, &data_dir)))
}

// ---------------------------------------------------------------------------
// download_file  (streams to a .part file; renames on completion)
// ---------------------------------------------------------------------------

/// One progress update for the setup wizard. `phase` lets a single event channel
/// drive the whole per-asset lifecycle in the UI: bytes accumulate during
/// `downloading`, then a brief `verifying` tick once the (incrementally computed)
/// hash is checked. Extraction status is driven from the frontend.
#[derive(Serialize, Clone)]
struct SetupProgress {
    asset_id: String,
    phase: &'static str, // "downloading" | "verifying"
    bytes_received: u64,
    total_bytes: Option<u64>,
}

/// Policy for an asset with no pinned SHA-256: accept (with a warning) in debug so
/// development against not-yet-pinned R2 objects isn't blocked, but fail closed in
/// release — running an unverified binary in a shipped build is unacceptable.
fn accept_unpinned_or_err(what: &str) -> Result<(), String> {
    if cfg!(debug_assertions) {
        eprintln!("WARNING: no pinned sha256 for {what}; skipping verification (debug build only)");
        Ok(())
    } else {
        Err(format!(
            "no pinned sha256 for {what}; refusing to accept an unverified asset in a release build"
        ))
    }
}

/// Feed bytes `[from, to)` of `path` into `hasher`. Used to seed the rolling hash
/// when resuming a `.part` left by a previous app run (the in-memory hasher didn't
/// see those bytes). Only this gap is read — not the whole file.
fn hash_file_range(
    path: &Path,
    hasher: &mut sha2::Sha256,
    from: u64,
    to: u64,
) -> Result<(), String> {
    use sha2::Digest;
    let mut f = fs::File::open(path).map_err(|e| format!("open .part for hashing failed: {e}"))?;
    f.seek(std::io::SeekFrom::Start(from))
        .map_err(|e| format!("seek failed: {e}"))?;
    let mut remaining = to - from;
    let mut buf = [0u8; 65536];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = f
            .read(&mut buf[..want])
            .map_err(|e| format!("read error: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

/// How many times to (re)connect for a single download before giving up and
/// letting the caller fall back to a different URL. Each retry resumes from the
/// bytes already on disk rather than restarting.
const DOWNLOAD_MAX_ATTEMPTS: u32 = 5;

/// Cap on how long to wait for the TCP connection to be established.
const CONNECT_TIMEOUT_SECS: u64 = 30;

/// Max gap with no bytes received before we treat the stream as stalled and
/// reconnect-resume. Deliberately generous: a healthy multi-GB download still
/// delivers data far more often than this, while a silently hung socket (which
/// reqwest would otherwise wait on forever) is caught and retried.
const STREAM_STALL_TIMEOUT_SECS: u64 = 60;

/// Minimum gap between `setup:progress` events. The raw chunk cadence is tens of
/// thousands of events for the multi-GB model — each one a React state update —
/// so we coalesce to ~10/sec, which keeps the bar smooth without the jank.
const PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

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

/// Monotonic "install generation". Each `download_file` binds to the value current
/// when it starts; if the global value moves on (the user cancelled, or a fresh
/// install run began), the in-flight download notices between/within chunks and
/// bails out — leaving its `.part` intact so a later run resumes from exactly where
/// it stopped. A counter (rather than a bool) makes the cancel→restart sequence
/// race-free: a lingering old download can never be "un-cancelled" by a new run,
/// and a new run never adopts an old download's cancellation.
static SETUP_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Cancel any in-flight setup download by advancing the generation. Safe to call
/// repeatedly; a download not currently running is unaffected.
#[tauri::command]
pub fn cancel_setup() {
    SETUP_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// How long an untouched `.part` is kept before the startup sweep reclaims it.
/// Long enough that an interrupted download the user means to resume (relaunch and
/// continue) is never disturbed, short enough that a truly abandoned multi-GB
/// partial doesn't linger forever.
const PARTIAL_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60); // 7 days

/// Garbage-collect abandoned `.part` files (design review M3 residual).
///
/// `download_file` intentionally *keeps* a `.part` across app runs so a dropped
/// download resumes from where it stopped — so this sweep must not touch recent
/// partials. It deletes only `.part` files older than [`PARTIAL_RETENTION`], which a
/// genuine resume never is. Best-effort and non-recursive over the two dirs that
/// hold download targets (the data dir root and `models/`); errors are ignored.
/// Called once at startup.
pub fn sweep_stale_partials(data_dir: &Path) {
    for dir in [data_dir.to_path_buf(), data_dir.join("models")] {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("part") {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|modified| {
                    modified
                        .elapsed()
                        .map(|age| age > PARTIAL_RETENTION)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if stale {
                let _ = fs::remove_file(&path);
            }
        }
    }
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

/// Download `url` to `dest_path`, verifying its SHA-256 *during* the download.
///
/// The hash is computed incrementally from the same bytes as they stream through
/// memory, so there is no second full-file read afterward (the old separate verify
/// pass re-read every byte — a wasted ~3.5 GB of disk I/O across the asset set).
/// The file is only renamed from `.part` to its final path once the hash matches,
/// so a corrupt/truncated download never leaves a "complete-looking" file behind.
/// On a hash mismatch the `.part` is kept so the caller can `clear_partial_download`
/// and fall back to the alternate URL.
#[tauri::command]
pub async fn download_file(
    app_handle: tauri::AppHandle,
    url: String,
    dest_path: String,
    asset_id: String,
    expected_sha256: String,
) -> Result<(), String> {
    use sha2::Digest;
    use tauri::Emitter;

    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }

    let part_path = PathBuf::from(format!("{dest_path}.part"));

    let client = reqwest::Client::builder()
        .user_agent("anchor-setup/1.0")
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    // Finalize once the bytes on disk are known-good: emit a `verifying` tick,
    // confirm the rolling hash (or apply the unpinned-asset policy), then rename.
    let finalize = |app_handle: &tauri::AppHandle,
                    hex: Option<String>,
                    bytes: u64,
                    total: Option<u64>|
     -> Result<(), String> {
        let _ = app_handle.emit(
            "setup:progress",
            SetupProgress {
                asset_id: asset_id.clone(),
                phase: "verifying",
                bytes_received: bytes,
                total_bytes: total,
            },
        );
        match hex {
            Some(actual) => {
                if !actual.eq_ignore_ascii_case(&expected_sha256) {
                    // Keep `.part` — caller clears it before trying the fallback URL.
                    return Err(format!(
                        "hash mismatch for {asset_id}: expected {expected_sha256}, got {actual}"
                    ));
                }
            }
            None => accept_unpinned_or_err(&dest_path)?, // empty expected hash
        }
        fs::rename(&part_path, &dest).map_err(|e| format!("rename failed: {e}"))
    };

    // Bind to the current install generation; if it advances (cancel / new run) we
    // abandon this download. Reading it once here means the normal sequential flow
    // (generation never moves) never self-cancels.
    let my_generation = SETUP_GENERATION.load(Ordering::SeqCst);
    let cancelled = || SETUP_GENERATION.load(Ordering::SeqCst) != my_generation;

    let verify = !expected_sha256.is_empty();
    // Rolling hash + how many of the final file's bytes it has consumed. Both live
    // across reconnect attempts so a resumed download still produces the full hash.
    let mut hasher = sha2::Sha256::new();
    let mut hashed_up_to: u64 = 0;

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
                tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
                continue;
            }
        };

        let status = response.status();

        // The `.part` is already >= the full object — nothing left to fetch. We
        // didn't stream it this run, so hash it from disk before finalizing.
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && resume_from > 0 {
            drop(response);
            let hex = if verify {
                let mut h = sha2::Sha256::new();
                hash_file_range(&part_path, &mut h, 0, resume_from)?;
                Some(format!("{:x}", h.finalize()))
            } else {
                None
            };
            return finalize(&app_handle, hex, resume_from, Some(resume_from));
        }

        if !status.is_success() {
            // Origin-level error; retrying the same URL won't help. Surface it so
            // the caller falls back to the alternate source.
            return Err(format!("HTTP {status} for {url}"));
        }

        // 206 → server honored Range, append. 200 → it ignored Range (or we had
        // nothing to resume), so (re)start from zero.
        let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT && resume_from > 0;

        // Keep the rolling hash consistent with the bytes about to be on disk.
        if verify {
            if resuming {
                // Seed any gap the in-memory hasher hasn't seen (e.g. a `.part`
                // left by a previous app run). After an in-run drop this is a no-op.
                if hashed_up_to < resume_from {
                    hash_file_range(&part_path, &mut hasher, hashed_up_to, resume_from)?;
                    hashed_up_to = resume_from;
                }
            } else {
                // Fresh start (or the server ignored Range and we truncate `.part`).
                hasher = sha2::Sha256::new();
                hashed_up_to = 0;
            }
        }

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
        // Seed so the first chunk emits immediately (checked_sub avoids an underflow
        // panic in the unlikely case the process started < PROGRESS_THROTTLE ago).
        let mut last_emit = Instant::now()
            .checked_sub(PROGRESS_THROTTLE)
            .unwrap_or_else(Instant::now);

        loop {
            // Cooperative cancellation: bail promptly (between chunks) if cancelled
            // or superseded. The `.part` is kept so a later run resumes from here.
            if cancelled() {
                return Err("setup cancelled".into());
            }

            // Bound each read so a silently hung socket is detected instead of
            // blocking forever; a timeout is handled the same as a stream drop.
            let next = tokio::time::timeout(
                Duration::from_secs(STREAM_STALL_TIMEOUT_SECS),
                stream.chunk(),
            )
            .await;

            match next {
                Ok(Ok(Some(chunk))) => {
                    // Re-check before writing so a chunk that arrived after cancellation
                    // is never appended (which would corrupt a `.part` a new run may own).
                    if cancelled() {
                        return Err("setup cancelled".into());
                    }
                    file.write_all(&chunk)
                        .map_err(|e| format!("write error: {e}"))?;
                    if verify {
                        hasher.update(&chunk);
                        hashed_up_to += chunk.len() as u64;
                    }
                    bytes_received += chunk.len() as u64;
                    // Coalesce progress events to PROGRESS_THROTTLE to avoid flooding the UI.
                    if last_emit.elapsed() >= PROGRESS_THROTTLE {
                        let _ = app_handle.emit(
                            "setup:progress",
                            SetupProgress {
                                asset_id: asset_id.clone(),
                                phase: "downloading",
                                bytes_received,
                                total_bytes,
                            },
                        );
                        last_emit = Instant::now();
                    }
                }
                Ok(Ok(None)) => break, // stream finished cleanly
                Ok(Err(e)) => {
                    last_err = format!("stream error: {e}");
                    stream_failed = true;
                    break;
                }
                Err(_) => {
                    last_err = format!("stream stalled (no data for {STREAM_STALL_TIMEOUT_SECS}s)");
                    stream_failed = true;
                    break;
                }
            }
        }

        drop(file);

        if stream_failed {
            // Bytes received so far are preserved in `.part`; back off and resume.
            tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
            continue;
        }

        // Final download progress so the bar reaches 100% even if the last chunk
        // was throttled, then verify-and-finalize from the rolling hash.
        let _ = app_handle.emit(
            "setup:progress",
            SetupProgress {
                asset_id: asset_id.clone(),
                phase: "downloading",
                bytes_received,
                total_bytes,
            },
        );
        let hex = verify.then(|| format!("{:x}", hasher.clone().finalize()));
        return finalize(&app_handle, hex, bytes_received, total_bytes);
    }

    Err(format!(
        "download failed after {DOWNLOAD_MAX_ATTEMPTS} attempts: {last_err}"
    ))
}

// ---------------------------------------------------------------------------
// verify_file_hash
// ---------------------------------------------------------------------------

// async so Tauri runs it on the async runtime instead of the main (UI) thread.
// The actual hashing is CPU-bound for minutes on the multi-GB GGUF files, so it
// goes on the blocking thread pool via spawn_blocking — running it directly on an
// async worker would block the main thread on macOS (beachball / "not responding")
// and could also stall the concurrent download streaming.
#[tauri::command]
pub async fn verify_file_hash(path: String, expected_sha256: String) -> Result<bool, String> {
    // Empty expected hash → asset not yet pinned; apply the shared fail-closed
    // (release) / warn-and-accept (debug) policy.
    if expected_sha256.is_empty() {
        return accept_unpinned_or_err(&path).map(|_| true);
    }

    tokio::task::spawn_blocking(move || {
        use sha2::{Digest, Sha256};

        let mut file = std::fs::File::open(&path).map_err(|e| format!("open failed: {e}"))?;

        let mut hasher = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = file
                .read(&mut buf)
                .map_err(|e| format!("read error: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }

        let actual = format!("{:x}", hasher.finalize());
        Ok(actual.eq_ignore_ascii_case(&expected_sha256))
    })
    .await
    .map_err(|e| format!("hash task failed: {e}"))?
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
        let file = fs::File::open(archive_path).map_err(|e| format!("open archive failed: {e}"))?;
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        // unpack() preserves permissions (incl. the executable bit) and rejects
        // entries that would escape `dest` via path traversal.
        archive
            .unpack(dest)
            .map_err(|e| format!("tar.gz extract failed: {e}"))?;
        return Ok(());
    }

    use zip::ZipArchive;
    let file = fs::File::open(archive_path).map_err(|e| format!("open archive failed: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("zip open failed: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
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
            let mut out_file =
                fs::File::create(&out_path).map_err(|e| format!("create file failed: {e}"))?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| format!("extract failed: {e}"))?;

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
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
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
        let Some(name) = path.file_name() else {
            continue;
        };
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

// async + spawn_blocking so unpacking (CPU- and disk-bound) runs on the blocking
// pool instead of the main/UI thread. This both keeps the wizard responsive and
// lets the frontend overlap an asset's extraction with the *next* asset's download.
#[tauri::command]
pub async fn extract_archive(
    archive_path: String,
    dest_dir: String,
    flatten_marker: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        extract_archive_inner(&archive_path, &dest_dir, flatten_marker)
    })
    .await
    .map_err(|e| format!("extract task failed: {e}"))?
}

fn extract_archive_inner(
    archive_path: &str,
    dest_dir: &str,
    flatten_marker: Option<String>,
) -> Result<(), String> {
    let dest = Path::new(dest_dir);

    if let Some(marker) = flatten_marker {
        // Stage alongside the archive, locate the real payload root, then lift it up.
        let staging = PathBuf::from(format!("{archive_path}.extract"));
        let _ = fs::remove_dir_all(&staging); // clear any stale staging dir
        extract_preserving(archive_path, &staging)?;

        let root = find_marker_dir(&staging, &marker)
            .ok_or_else(|| format!("'{marker}' not found inside archive"))?;

        copy_dir_contents(&root, dest)?;
        let _ = fs::remove_dir_all(&staging);
    } else {
        extract_preserving(archive_path, dest)?;
    }

    fs::remove_file(archive_path).ok();
    Ok(())
}

// ---------------------------------------------------------------------------
// get_setup_paths / persist_backend
// ---------------------------------------------------------------------------

/// The chosen acceleration backend, persisted to AppData (not just webview
/// localStorage) so it survives a launch that skips the wizard. localStorage is
/// per-origin, so the dev origin (localhost:1420) and the packaged origin
/// (tauri/asset localhost) keep *separate* stores: a build that finds the shared
/// AppData assets already present skips the wizard and would otherwise fall back to
/// the `cpu` default — launching llama-server with `--n-gpu-layers 0` and running
/// generation on the CPU even when a GPU build is installed. Mirroring the choice on
/// disk lets the auto-heal in `useSetupCheck` restore it for any origin.
const BACKEND_FILENAME: &str = "hardware_backend";

/// Backends the frontend may persist; guards against writing a garbage value that
/// would later flow into the llama-server `--n-gpu-layers` decision.
const VALID_BACKENDS: [&str; 4] = ["cpu", "cuda", "rocm", "metal"];

#[derive(Serialize)]
pub struct SetupPaths {
    pub llama_server: String,
    pub model_path: String,
    pub mmproj_path: String,
    /// Backend last persisted by the wizard, or `None` if never written / invalid.
    pub hardware_backend: Option<String>,
}

/// Read the backend persisted by the wizard from `data_dir`, ignoring an absent file
/// or any value that isn't a recognized backend (corrupt/hand-edited) so a bad token
/// can't reach the server. Shared by `get_setup_paths` and llama-server startup.
pub fn read_persisted_backend(data_dir: &Path) -> Option<String> {
    fs::read_to_string(data_dir.join(BACKEND_FILENAME))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| VALID_BACKENDS.contains(&s.as_str()))
}

#[tauri::command]
pub fn get_setup_paths(app_handle: tauri::AppHandle) -> Result<SetupPaths, String> {
    let d = resolve_data_dir(&app_handle)?;
    let hardware_backend = read_persisted_backend(&d);
    Ok(SetupPaths {
        llama_server: d
            .join("binaries")
            .join(llama_exe_name())
            .to_string_lossy()
            .into_owned(),
        model_path: d
            .join("models")
            .join(MODEL_FILENAME)
            .to_string_lossy()
            .into_owned(),
        mmproj_path: d
            .join("models")
            .join(MMPROJ_FILENAME)
            .to_string_lossy()
            .into_owned(),
        hardware_backend,
    })
}

/// Persist the wizard's chosen acceleration backend to AppData so it can be restored
/// on a later launch whose (per-origin) localStorage never saw the wizard. Rejects an
/// unrecognized value rather than writing it.
#[tauri::command]
pub fn persist_backend(app_handle: tauri::AppHandle, backend: String) -> Result<(), String> {
    if !VALID_BACKENDS.contains(&backend.as_str()) {
        return Err(format!("unknown backend: {backend}"));
    }
    let d = resolve_data_dir(&app_handle)?;
    fs::write(d.join(BACKEND_FILENAME), &backend)
        .map_err(|e| format!("failed to persist backend: {e}"))
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
    /// Human-readable upstream version this asset is pinned to, for audit (design
    /// review F7). The R2 object keys strip the build tag, so this records what the
    /// pinned SHA-256 actually corresponds to. `None` where no stable version string
    /// applies (e.g. PDFium prebuilts). Refresh in lockstep with the `sha256` pins.
    pub version: Option<String>,
}

// Pinned llama.cpp release the llama-server (and CUDA-runtime) binaries come from.
// Verified by running the installed Windows CUDA binary: `llama-server --version`
// → `version: 9596 (18ef86ece)`. llama.cpp publishes every platform binary under a
// single build tag per release, so win-cpu / win-cuda / macos-arm64 share this build.
// To refresh after pinning new archives, re-run `llama-server --version` (or read the
// `build:`/`version:` line) and update this alongside the SHA-256s above.
const LLAMA_CPP_BUILD: &str = "b9596 (18ef86ece)";

// Pinned model revision for the two GGUF files — the unsloth repo commit the
// fallback URLs (and SHA-256 pins) reference; see HF_MODEL_URL / HF_MMPROJ_URL.
const QWEN_MODEL_REVISION: &str = "unsloth/Qwen3.5-4B-GGUF@e87f176";

// llama.cpp release archives are uploaded to R2 as-is, under `binaries/`, with the
// build tag and CUDA version stripped from the filename. Examples:
//   llama-b9596-bin-win-cpu-x64.zip        → binaries/llama-bin-win-cpu-x64.zip
//   llama-b9596-bin-win-cuda-13.3-x64.zip  → binaries/llama-bin-win-cuda-x64.zip
//   cudart-llama-bin-win-cuda-13.3-x64.zip → binaries/cudart-llama-bin-win-cuda-x64.zip
//   llama-b9596-bin-macos-arm64.tar.gz     → binaries/llama-bin-macos-arm64.tar.gz
// (All three platform builds are the same release — see LLAMA_CPP_BUILD below.)
// Windows/Linux zips are flat; the macOS .tar.gz nests binaries under build/bin.
// extract_archive(flatten=true) normalizes both so llama-server[.exe] and its
// shared libraries end up directly in the `binaries` dir.
fn get_llama_server_spec(backend: &str) -> (&'static str, u64, &'static str, &'static str) {
    // (label, size_bytes, r2_object_key, sha256_of_archive)
    // size_bytes is the R2 object's actual Content-Length (verified 2026-06-16); it
    // seeds the progress bar / time-remaining estimate before the download's own
    // Content-Length arrives. The hash pins the downloaded archive at dest_path
    // (pre-extraction). Empty = not yet uploaded to R2, so verify_file_hash skips it.
    if cfg!(target_os = "macos") {
        // macOS releases are .tar.gz (nested under build/bin) — see extract_archive.
        return (
            "llama.cpp server (Metal / Apple Silicon)",
            10_547_769,
            "llama-bin-macos-arm64.tar.gz",
            "b77565f38c8cad9b0132dd4dbca54e201e8fb5b654d57780b87e0e05da25fafe",
        );
    }
    if cfg!(target_os = "windows") {
        // The Windows archives are re-packed to bundle the VC++ 2015–2022 runtime
        // (vcruntime140*.dll, msvcp140*.dll) alongside llama-server.exe, so it runs on a
        // clean Windows install with no Visual C++ Redistributable present (docs/fix-vcruntime.md).
        // size_bytes + sha256 below pin those re-packed archives.
        return if backend == "cuda" {
            (
                "llama.cpp server (CUDA / GPU)",
                267_375_219,
                "llama-bin-win-cuda-x64.zip",
                "e3a09d29971b652341707e0b04697a75d052f577a01740a8628233b745905389",
            )
        } else {
            (
                "llama.cpp server (CPU)",
                17_727_250,
                "llama-bin-win-cpu-x64.zip",
                "b4e52ee641ba414d0daae3064d6332c94f25bb6dcd4a286f536edb4c9c7c98fa",
            )
        };
    }
    // Linux — upstream only publishes CPU (ubuntu) builds; GPU backends fall back to it.
    // Not yet uploaded to R2 — size is a rough placeholder, hash empty, until it is.
    (
        "llama.cpp server (CPU)",
        25_000_000,
        "llama-bin-ubuntu-x64.zip",
        "",
    )
}

fn get_tesseract_spec(data_dir: &Path) -> AssetManifestEntry {
    // sha256 pins the downloaded tesseract.zip (pre-extraction). Empty = not yet
    // uploaded to R2 (Linux), so verify_file_hash skips it.
    // size_bytes = actual R2 Content-Length (verified 2026-06-16).
    let (label, size_bytes, url_suffix, sha256) = if cfg!(target_os = "windows") {
        (
            "Tesseract OCR engine (38 MB)",
            38_218_316u64,
            "windows/tesseract.zip",
            "268ded1253c5697071915e0dcea6c32a278bf037d51d0602165d4502c113dd1a",
        )
    } else if cfg!(target_os = "macos") {
        (
            "Tesseract OCR engine (5.7 MB)",
            5_701_459u64,
            "macos/tesseract.zip",
            "efe841cbccfa2f65664101546a93cc47a793dcf8b2313d47460ca234482430ab",
        )
    } else {
        (
            "Tesseract OCR engine (15 MB)",
            15_000_000u64,
            "linux/tesseract.zip",
            "",
        )
    };

    AssetManifestEntry {
        asset_id: "tesseract".into(),
        label: label.into(),
        size_bytes,
        dest_path: data_dir
            .join("tesseract.zip")
            .to_string_lossy()
            .into_owned(),
        sha256: sha256.into(),
        url_primary: format!("{R2_BASE}/{url_suffix}"),
        url_fallback: None,
        extract_to_dir: Some(data_dir.join("tesseract").to_string_lossy().into_owned()),
        // Installer zips wrap files in a folder (e.g. tesseract-w64/); find the
        // real root by the tesseract binary. tessdata/ subtree is preserved.
        flatten_marker: Some("tesseract".into()),
        installed: false, // filled in by get_asset_manifest
        version: None,    // upstream Tesseract build not separately pinned
    }
}

#[tauri::command]
pub fn get_asset_manifest(
    app_handle: tauri::AppHandle,
    backend: String,
) -> Result<Vec<AssetManifestEntry>, String> {
    let data_dir = resolve_data_dir(&app_handle)?;
    let binaries_dir = data_dir.join("binaries").to_string_lossy().into_owned();
    let (label, size_bytes, r2_key, llama_sha) = get_llama_server_spec(&backend);

    // Keep the local archive's extension matching the upstream format so
    // extract_archive can dispatch zip vs tar.gz.
    let llama_archive = if is_targz(r2_key) {
        "llama.tar.gz"
    } else {
        "llama.zip"
    };

    let llama = AssetManifestEntry {
        asset_id: "llama_server".into(),
        label: label.into(),
        size_bytes,
        dest_path: data_dir.join(llama_archive).to_string_lossy().into_owned(),
        sha256: llama_sha.into(),
        url_primary: format!("{R2_BASE}/binaries/{r2_key}"),
        url_fallback: None,
        extract_to_dir: Some(binaries_dir.clone()),
        flatten_marker: Some("llama-server".into()), // macOS nests under build/bin; Windows is flat
        installed: false,
        version: Some(LLAMA_CPP_BUILD.into()),
    };

    // Windows CUDA builds need the CUDA runtime DLLs, which llama.cpp ships as a
    // separate zip. Its DLLs sit flat at the root, so a plain extract into the
    // binaries dir places them alongside llama-server.exe.
    let cudart = (cfg!(target_os = "windows") && backend == "cuda").then(|| AssetManifestEntry {
        asset_id: "cudart".into(),
        label: "CUDA runtime libraries".into(),
        size_bytes: 391_443_627, // actual R2 Content-Length (verified 2026-06-16)
        dest_path: data_dir.join("cudart.zip").to_string_lossy().into_owned(),
        sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6".into(),
        url_primary: format!("{R2_BASE}/binaries/cudart-llama-bin-win-cuda-x64.zip"),
        url_fallback: None,
        extract_to_dir: Some(binaries_dir.clone()),
        flatten_marker: None, // DLLs sit flat at the zip root
        installed: false,
        // Shipped as part of the same llama.cpp CUDA release archive set.
        version: Some(LLAMA_CPP_BUILD.into()),
    });

    // PDFium renderer (Windows + macOS; see pdfium_spec). The library nests under
    // a wrapper folder in the archive, so flatten by its filename to drop it
    // directly into the binaries dir.
    let pdfium = pdfium_spec().map(|(key, sha, size)| AssetManifestEntry {
        asset_id: "pdfium".into(),
        label: "PDFium renderer".into(),
        size_bytes: size,
        dest_path: data_dir.join("pdfium.tgz").to_string_lossy().into_owned(),
        sha256: sha.into(),
        url_primary: format!("{R2_BASE}/binaries/{key}"),
        url_fallback: None,
        extract_to_dir: Some(binaries_dir),
        flatten_marker: Some(pdfium_lib_name().into()),
        installed: false,
        version: None, // pdfium prebuild not separately pinned
    });

    let tesseract = get_tesseract_spec(&data_dir);

    let mmproj = AssetManifestEntry {
        asset_id: "mmproj_gguf".into(),
        label: "Vision projector (672 MB)".into(),
        size_bytes: 672_423_616, // actual R2 Content-Length (verified 2026-06-16)
        dest_path: data_dir
            .join("models")
            .join(MMPROJ_FILENAME)
            .to_string_lossy()
            .into_owned(),
        sha256: "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864".into(),
        url_primary: format!("{R2_BASE}/models/{MMPROJ_FILENAME}"),
        url_fallback: Some(HF_MMPROJ_URL.into()),
        extract_to_dir: None,
        flatten_marker: None,
        installed: false,
        version: Some(QWEN_MODEL_REVISION.into()),
    };

    let model = AssetManifestEntry {
        asset_id: "model_gguf".into(),
        label: "Qwen language model (2.7 GB)".into(),
        size_bytes: 2_740_937_888, // actual R2 Content-Length (verified 2026-06-16)
        dest_path: data_dir
            .join("models")
            .join(MODEL_FILENAME)
            .to_string_lossy()
            .into_owned(),
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4".into(),
        url_primary: format!("{R2_BASE}/models/{MODEL_FILENAME}"),
        url_fallback: Some(HF_MODEL_URL.into()),
        extract_to_dir: None,
        flatten_marker: None,
        installed: false,
        version: Some(QWEN_MODEL_REVISION.into()),
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
    Ok(assets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    #[test]
    fn is_targz_recognizes_gzip_tarballs() {
        assert!(is_targz("foo.tar.gz"));
        assert!(is_targz("FOO.TGZ"));
        assert!(is_targz("pdfium-win-x64.tgz"));
        assert!(!is_targz("llama.zip"));
        assert!(!is_targz("model.gguf"));
    }

    #[test]
    fn accept_unpinned_is_ok_in_debug_test_build() {
        // Tests compile with debug_assertions, so the unpinned policy accepts (warns).
        assert!(accept_unpinned_or_err("some-asset").is_ok());
    }

    #[test]
    fn hash_file_range_hashes_only_the_requested_window() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        fs::write(&path, b"0123456789").unwrap();

        // Hash bytes [2, 7) == "23456" via the helper.
        let mut h = Sha256::new();
        hash_file_range(&path, &mut h, 2, 7).unwrap();
        let got = format!("{:x}", h.finalize());

        let want = format!("{:x}", Sha256::digest(b"23456"));
        assert_eq!(got, want);
    }

    #[test]
    fn find_marker_dir_locates_a_nested_payload_root() {
        let dir = tempfile::tempdir().unwrap();
        // Simulate an archive that wrapped the binary two folders deep.
        let nested = dir.path().join("wrapper").join("build").join("bin");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("llama-server"), b"x").unwrap();

        let found = find_marker_dir(dir.path(), "llama-server").expect("marker dir found");
        assert_eq!(found, nested);

        assert!(find_marker_dir(dir.path(), "does-not-exist").is_none());
    }

    #[test]
    fn copy_dir_contents_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let dest = dir.path().join("dest");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("bin"), b"hello").unwrap();
        fs::write(src.join("sub").join("data"), b"world").unwrap();

        copy_dir_contents(&src, &dest).unwrap();
        // Re-extracting over the existing copy must succeed (CR:M16).
        copy_dir_contents(&src, &dest).unwrap();

        assert_eq!(fs::read(dest.join("bin")).unwrap(), b"hello");
        assert_eq!(fs::read(dest.join("sub").join("data")).unwrap(), b"world");
    }

    #[test]
    #[cfg(unix)]
    fn copy_dir_contents_overwrites_a_read_only_target() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let dest = dir.path().join("dest");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("tool"), b"v2").unwrap();

        copy_dir_contents(&src, &dest).unwrap();
        // Release binaries ship as 0o555 (no owner write) — re-extract must still work.
        fs::set_permissions(dest.join("tool"), fs::Permissions::from_mode(0o555)).unwrap();
        copy_dir_contents(&src, &dest).unwrap();
        assert_eq!(fs::read(dest.join("tool")).unwrap(), b"v2");
    }

    #[test]
    fn asset_installed_detects_installed_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let binaries = dir.path().join("binaries");
        fs::create_dir_all(&binaries).unwrap();

        assert!(!asset_installed("llama_server", dir.path()));
        fs::write(binaries.join(llama_exe_name()), b"x").unwrap();
        assert!(asset_installed("llama_server", dir.path()));

        // tesseract needs both the binary and the language data.
        let tess = dir.path().join("tesseract");
        fs::create_dir_all(tess.join("tessdata")).unwrap();
        fs::write(tess.join(tesseract_exe_name()), b"x").unwrap();
        assert!(!asset_installed("tesseract", dir.path()));
        fs::write(tess.join("tessdata").join("eng.traineddata"), b"x").unwrap();
        assert!(asset_installed("tesseract", dir.path()));
    }

    #[test]
    fn sweep_stale_partials_keeps_fresh_and_reclaims_old(/* NC:A2 */) {
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("fresh.part");
        let old = dir.path().join("old.part");
        let other = dir.path().join("keep.txt");
        fs::write(&fresh, b"resumable").unwrap();
        fs::write(&old, b"abandoned").unwrap();
        fs::write(&other, b"not a part").unwrap();

        // Backdate the old partial well beyond the 7-day retention window.
        let ten_days_ago = SystemTime::now() - Duration::from_secs(10 * 24 * 60 * 60);
        filetime::set_file_mtime(&old, filetime::FileTime::from_system_time(ten_days_ago)).unwrap();

        sweep_stale_partials(dir.path());

        assert!(
            fresh.exists(),
            "a recent .part (a genuine resume) must be kept"
        );
        assert!(
            !old.exists(),
            "a .part older than the retention window must be reclaimed"
        );
        assert!(other.exists(), "non-.part files must be untouched");
    }

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

        extract_archive_inner(
            &archive.to_string_lossy(),
            &dest.to_string_lossy(),
            Some(lib.to_string()),
        )
        .expect("extract_archive failed");

        // The library must land flat in dest…
        assert!(
            dest.join(lib).exists(),
            "{lib} did not land flat in {}",
            dest.display()
        );
        // …with the wrapper dirs collapsed away (only the marker dir's contents copied).
        assert!(
            !dest.join("include").exists(),
            "wrapper dir 'include' leaked into dest"
        );
        // asset_installed must now agree the asset is present.
        assert!(
            asset_installed("pdfium", &work),
            "asset_installed(pdfium) should be true"
        );

        let _ = fs::remove_dir_all(&work);
    }
}
