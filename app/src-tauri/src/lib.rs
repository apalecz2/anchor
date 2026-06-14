mod hardware;
mod llama;
mod ocr;
mod paths;
mod setup;

use tauri::{Manager, WindowEvent};

use llama::{stop_llama_server_process, AppState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Best-effort at startup; process_document re-runs this so OCR also
            // works when Tesseract is installed by the wizard mid-session.
            if let Ok(data_dir) = app.path().app_data_dir() {
                ocr::configure_tesseract_env(&data_dir);
            }
            Ok(())
        })
        .manage(AppState {
            llama_server: std::sync::Mutex::new(None),
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
            ocr::process_document,
            // Llama server
            llama::resolve_llama_server_path,
            llama::start_llama_server,
            llama::stop_llama_server,
            // Setup wizard
            setup::check_setup_complete,
            hardware::detect_hardware,
            setup::download_file,
            setup::clear_partial_download,
            setup::verify_file_hash,
            setup::get_setup_paths,
            setup::get_asset_manifest,
            setup::extract_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
