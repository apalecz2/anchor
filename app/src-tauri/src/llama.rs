//! llama.cpp server lifecycle.
//!
//! Owns the spawned `llama-server` child process via [`AppState`] and exposes
//! commands to resolve its path, start it, and stop it. The process is killed on
//! window close (wired up in `lib.rs`).

use std::{
    process::{Child, Command},
    sync::Mutex,
};

use crate::paths::{llama_exe_name, resolve_data_dir};

const DEFAULT_CTX_SIZE: &str = "8192";
const DEFAULT_IMAGE_MIN_TOKENS: &str = "1024";
const DEFAULT_N_PARALLEL: &str = "1";

pub struct AppState {
    pub llama_server: Mutex<Option<Child>>,
}

pub fn stop_llama_server_process(state: &AppState) -> Result<(), String> {
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
pub fn resolve_llama_server_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let binary = resolve_data_dir(&app_handle).join("binaries").join(llama_exe_name());
    if binary.exists() {
        Ok(binary.to_string_lossy().into_owned())
    } else {
        Err("llama-server not found — run the setup wizard to download it.".into())
    }
}

#[tauri::command]
pub fn start_llama_server(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_path: String,
    mmproj_path: String,
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

    // Resolve the executable in Rust from AppData rather than trusting a path
    // supplied by the webview — accepting a frontend path would let XSS spawn an
    // arbitrary local binary. The model/mmproj args are only
    // ever passed as data to this fixed binary, never executed.
    let llama_server_path = resolve_data_dir(&app_handle)
        .join("binaries")
        .join(llama_exe_name());
    if !llama_server_path.exists() {
        return Err("llama-server not found — run the setup wizard to download it.".into());
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
pub fn stop_llama_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    stop_llama_server_process(&state)
}
