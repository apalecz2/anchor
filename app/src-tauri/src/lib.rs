mod hardware;
mod llama;
mod ocr;
mod paths;
mod setup;

use tauri::{Manager, WindowEvent};

use llama::{stop_llama_server_process, sweep_orphan_server, AppState};
use ocr::ProcessState;

/// Label of the primary window (Tauri's default when none is configured). The
/// close handler only kills the shared llama-server for *this* window, so a future
/// secondary window (e.g. a viewer popout) closing can't tear down an in-flight
/// extraction.
const MAIN_WINDOW_LABEL: &str = "main";

/// Default filename used by tauri-plugin-window-state, stored in the app config
/// dir. Its presence is how we detect whether this is a first launch.
const WINDOW_STATE_FILENAME: &str = ".window-state.json";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Ok(data_dir) = app.path().app_data_dir() {
                // Best-effort at startup; process_document re-runs this so OCR also
                // works when Tesseract is installed by the wizard mid-session.
                ocr::configure_tesseract_env(&data_dir);
                // Reap a llama-server orphaned by a previous crash/taskkill before
                // it lingers holding multi-GB of RAM.
                sweep_orphan_server(&data_dir);
            }

            // On first launch there is no saved window state for the window-state
            // plugin to restore, so size the window to half the current monitor and
            // center it. Subsequent launches are handled by the plugin, which
            // restores the last size/position the user left.
            let has_saved_state = app
                .path()
                .app_config_dir()
                .map(|dir| dir.join(WINDOW_STATE_FILENAME).exists())
                .unwrap_or(false);
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                if !has_saved_state {
                    if let Ok(Some(monitor)) = window.current_monitor() {
                        let screen = monitor.size();
                        let half = tauri::PhysicalSize::new(screen.width / 2, screen.height / 2);
                        let _ = window.set_size(half);
                        let _ = window.center();
                    }
                }
                // The window starts hidden (config `visible: false`) so the user
                // never sees the brief resize from the config default to the
                // restored/half-screen size. Reveal it once sizing is settled.
                let _ = window.show();
            }
            Ok(())
        })
        .manage(AppState::new())
        .manage(ProcessState::new())
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. })
                && window.label() == MAIN_WINDOW_LABEL
            {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let _ = stop_llama_server_process(&state);
                }
            }
        })
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            // Document processing
            ocr::process_document,
            ocr::cancel_process_document,
            // Llama server
            llama::resolve_llama_server_path,
            llama::start_llama_server,
            llama::stop_llama_server,
            llama::get_llama_server_port,
            llama::llama_server_status,
            // Setup wizard
            setup::check_setup_complete,
            hardware::detect_hardware,
            setup::download_file,
            setup::clear_partial_download,
            setup::cancel_setup,
            setup::verify_file_hash,
            setup::get_setup_paths,
            setup::get_asset_manifest,
            setup::extract_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
