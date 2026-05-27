use std::{path::PathBuf, process::{Child, Command}, sync::Mutex};

const DEFAULT_CTX_SIZE: &str = "8192";
const DEFAULT_IMAGE_MIN_TOKENS: &str = "1024";

struct AppState {
    llama_server: Mutex<Option<Child>>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
fn start_llama_server(model_path: String, mmproj_path: String, llama_server_path: String) -> Result<u32, String> {
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

    Ok(pid)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            llama_server: Mutex::new(None),
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, resolve_llama_server_path, start_llama_server])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
