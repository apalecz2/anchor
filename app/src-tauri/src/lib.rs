mod consent;
mod export;
mod hardware;
mod install;
mod llama;
/// Only *used* on macOS (see the module docs for why no other platform gets a
/// menu bar), but compiled everywhere on purpose: `#[cfg]`-gating it to macOS
/// meant a Windows `cargo clippy` couldn't see it, so mistakes in it reached CI
/// unbuilt. `allow(dead_code)` covers the platforms that never call it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod menu;
mod ocr;
mod paths;
/// Compiled and unit-tested before anything executes it, so the catalog it holds
/// can't drift from the code it describes while the executor is still being built.
mod pipeline;
mod reset;
mod setup;
mod zoom;

use tauri::{Manager, WindowEvent};

use llama::{stop_all_servers, sweep_orphan_server, AppState};
use ocr::ProcessState;
use zoom::ZoomState;

/// Label of the primary window (Tauri's default when none is configured). The
/// close handler only kills the shared llama-server for *this* window, so a future
/// secondary window (e.g. a viewer popout) closing can't tear down an in-flight
/// extraction.
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// Default filename used by tauri-plugin-window-state, stored in the app config
/// dir. Its presence is how we detect whether this is a first launch.
const WINDOW_STATE_FILENAME: &str = ".window-state.json";

/// Logical size the UI is designed around — mirrors the window size in
/// `tauri.conf.json`. Below roughly this width the layout starts folding: the
/// sidebar stops reserving its gutter and overlays the content (`AppLayout`, at
/// Tailwind's `md`), and the session's two panes drop under `SplitLayout`'s
/// 360px floor.
const DEFAULT_WINDOW_SIZE: (f64, f64) = (1200.0, 800.0);

/// Most of the monitor's work area a first-run window may occupy, so a window
/// sized down to fit a small screen still reads as a window rather than filling
/// it edge to edge.
const FIRST_RUN_MAX_FILL: f64 = 0.92;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // macOS gets the system menu bar; every other platform draws its own title
    // bar in the webview instead (`TitleBar.tsx`) and attaches no native menu.
    #[cfg(target_os = "macos")]
    let builder = tauri::Builder::default()
        .menu(menu::build)
        .on_menu_event(menu::on_menu_event);
    #[cfg(not(target_os = "macos"))]
    let builder = tauri::Builder::default();

    builder
        .setup(|app| {
            if let Ok(data_dir) = app.path().app_data_dir() {
                // Configure Tesseract's PATH / TESSDATA_PREFIX once, here on the main
                // thread, before any command can run. It points at the canonical
                // AppData tesseract location even if the wizard hasn't installed it
                // yet, so a mid-session install is picked up without a restart — and
                // OCR never has to mutate process env from a worker thread.
                ocr::configure_tesseract_env(&data_dir);
                // Reap a llama-server orphaned by a previous crash/taskkill before
                // it lingers holding multi-GB of RAM.
                sweep_orphan_server(&data_dir);
                // Reclaim multi-GB `.part` files from downloads the user abandoned
                // for good (older than the retention window; recent resumes are kept).
                setup::sweep_stale_partials(&data_dir);
            }

            // Reclaim OCR scratch directories a crashed run never got to delete.
            // Age-gated, so it cannot touch a run still in flight in another
            // instance of the app (there is no single-instance lock).
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                ocr::sweep_stale_ocr_work_dirs(&cache_dir);
            }

            // On first launch there is no saved window state for the window-state
            // plugin to restore, so open at the size the UI was designed for,
            // shrinking only as far as this monitor requires. Subsequent launches
            // are handled by the plugin, which restores the last size/position the
            // user left.
            //
            // All of this is done in *logical* pixels, which is the whole point:
            // `monitor.size()` is physical, so sizing from it directly divides the
            // window by the display's scale factor a second time — a 1200-logical
            // window becomes 800 CSS px at 150% and 600 at 200%, meaning the
            // sharper the user's display, the more squished the app opened. Every
            // measurement the layout cares about is a CSS pixel, so convert once
            // here and stay in that space.
            let has_saved_state = app
                .path()
                .app_config_dir()
                .map(|dir| dir.join(WINDOW_STATE_FILENAME).exists())
                .unwrap_or(false);
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                if !has_saved_state {
                    if let Ok(Some(monitor)) = window.current_monitor() {
                        let scale = monitor.scale_factor();
                        // Work area, not monitor size: it excludes the taskbar,
                        // the dock and the macOS menu bar.
                        let area = monitor.work_area();
                        let avail = area.size.to_logical::<f64>(scale);
                        let (design_w, design_h) = DEFAULT_WINDOW_SIZE;
                        let width = design_w.min(avail.width * FIRST_RUN_MAX_FILL);
                        let height = design_h.min(avail.height * FIRST_RUN_MAX_FILL);
                        let _ = window.set_size(tauri::LogicalSize::new(width, height));
                        // Centered within the work area rather than the monitor
                        // (`window.center()`), so a window sized to nearly fill a
                        // small screen doesn't end up tucked under the taskbar.
                        let origin = area.position.to_logical::<f64>(scale);
                        let _ = window.set_position(tauri::LogicalPosition::new(
                            origin.x + (avail.width - width) / 2.0,
                            origin.y + (avail.height - height) / 2.0,
                        ));
                    }
                }
                // Drop the OS title bar so `TitleBar.tsx` can draw its own with
                // the View menu in it. Done here rather than in tauri.conf.json
                // because macOS keeps its decorations — it gets a transparent
                // overlay title bar (`titleBarStyle`) with the real traffic
                // lights floating over our header — and a per-platform config
                // file would have to duplicate the whole window definition,
                // since Tauri merge-patches those and replaces arrays wholesale.
                // tao keeps undecorated windows resizable (it hit-tests the
                // frame itself), so nothing is lost but the caption.
                #[cfg(not(target_os = "macos"))]
                let _ = window.set_decorations(false);

                // The window starts hidden (config `visible: false`) so the user
                // never sees the brief resize from the config default to the
                // restored/half-screen size — nor the decorated frame blinking
                // away just above. Reveal it once sizing is settled.
                let _ = window.show();
            }
            Ok(())
        })
        .manage(AppState::new())
        .manage(ProcessState::new())
        .manage(ZoomState::new())
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. })
                && window.label() == MAIN_WINDOW_LABEL
            {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let _ = stop_all_servers(&state);
                }
            }
        })
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            // Document processing
            ocr::process_document,
            ocr::cancel_process_document,
            // Export
            export::export_xlsx,
            // About / diagnostics
            install::get_install_info,
            // Data removal (Settings ▸ Data)
            reset::remove_all_app_data,
            reset::quit_app,
            // Clickwrap consent record (mirrors localStorage to AppData)
            consent::read_consent_record,
            consent::write_consent_record,
            // Title bar / View menu
            zoom::set_app_zoom,
            zoom::get_app_zoom,
            zoom::app_zoom_limits,
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
            setup::persist_backend,
            setup::get_asset_manifest,
            setup::extract_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
