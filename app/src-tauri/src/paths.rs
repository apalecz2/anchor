//! Shared path and filename helpers.
//!
//! Low-level primitives used across OCR, llama-server, and setup modules:
//! resolving the AppData directory and the platform-specific names of the
//! binaries/libraries the app ships. This module has no dependencies on the
//! other feature modules, keeping the crate's module graph acyclic.

use std::path::PathBuf;

use tauri::Manager;

pub const MODEL_FILENAME: &str = "Qwen3.5-4B-Q4_K_M.gguf";
pub const MMPROJ_FILENAME: &str = "mmproj-F16.gguf";

pub fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve AppData directory")
}

pub fn llama_exe_name() -> &'static str {
    if cfg!(target_os = "windows") { "llama-server.exe" } else { "llama-server" }
}

pub fn tesseract_exe_name() -> &'static str {
    if cfg!(target_os = "windows") { "tesseract.exe" } else { "tesseract" }
}

/// Filename of the PDFium shared library once extracted into the binaries dir.
/// Also used as the archive's flatten marker, since the library file is what we
/// lift out of the archive's wrapper folder.
pub fn pdfium_lib_name() -> &'static str {
    if cfg!(target_os = "windows") { "pdfium.dll" } else { "libpdfium.dylib" }
}

/// (r2_object_key, sha256_of_archive, approx_size_bytes) for the current
/// platform's prebuilt PDFium, or None on platforms we don't ship one for.
/// pdfium-render binds to a system pdfium at runtime; neither Windows nor macOS
/// has one, so we provide the upstream build. The Windows archive nests the lib
/// under bin/, the macOS one under lib/ — flatten_marker normalizes both.
pub fn pdfium_spec() -> Option<(&'static str, &'static str, u64)> {
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
