//! In-app data removal ("Remove all downloaded data").
//!
//! Backs the two destructive actions in Settings ▸ Data: *Reset Anchor* (wipe, then
//! return to first-run setup) and *Remove all data and quit* (wipe, then close, so the
//! app can be uninstalled leaving nothing behind). Both run the same wipe and differ
//! only in whether the emptied directories are recreated for the still-running process.
//!
//! Why it exists: the first-run wizard downloads ~3.5 GB into AppData, which no
//! uninstaller of ours touches (and which MSIX may leave behind, virtualized). Leaving
//! that on disk after an uninstall is a trust problem, a hard Microsoft Store
//! requirement (policy 10.2.7 — docs/release.md §6.4), and something the Privacy Policy
//! promises by name.

use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::Manager;

use crate::llama::{stop_all_servers, AppState};
use crate::ocr::{request_cancel_processing, ProcessState};
use crate::paths::resolve_data_dir;
use crate::setup::cancel_setup;

/// Windows refuses to delete a file another handle still holds, and a handle released
/// microseconds ago (llama-server exiting, an AV scanner sweeping the just-closed GGUF)
/// can still be live when we get there. Retrying a few times over ~1s turns those
/// transient failures into successes instead of a scary partial wipe.
const REMOVE_ATTEMPTS: u32 = 4;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Serialize, Default)]
pub struct RemovalReport {
    /// Bytes actually reclaimed — only entries that were removed are counted.
    pub freed_bytes: u64,
    /// Absolute paths that survived every attempt (still open in another process).
    /// Surfaced to the user rather than quietly reporting success.
    pub failed: Vec<String>,
}

/// Size of a file, or of every file under a directory. Measured before removal so the
/// report can state how much was reclaimed. A path we can't stat contributes 0 rather
/// than failing the wipe, and symlinks are measured as links (never followed off into
/// a subtree we have no business deleting).
fn entry_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_dir() {
        fs::read_dir(path)
            .map(|entries| entries.flatten().map(|e| entry_size(&e.path())).sum())
            .unwrap_or(0)
    } else {
        meta.len()
    }
}

fn remove_entry(path: &Path) -> std::io::Result<()> {
    // symlink_metadata, so a symlinked directory is unlinked rather than recursed into.
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// Remove one file or subtree, retrying transient lock failures. The size is measured
/// once up front, so a subtree that only succeeds on a later attempt still reports its
/// full size; one that never succeeds reports nothing even if part of it went, which
/// keeps the number honest in the direction that matters (never overstating).
fn remove_with_retry(path: &Path, report: &mut RemovalReport) {
    let size = entry_size(path);
    for attempt in 1..=REMOVE_ATTEMPTS {
        match remove_entry(path) {
            Ok(()) => {
                report.freed_bytes += size;
                return;
            }
            // Already gone (or removed by an earlier pass) — not a failure.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < REMOVE_ATTEMPTS => thread::sleep(REMOVE_RETRY_DELAY),
            Err(_) => report.failed.push(path.display().to_string()),
        }
    }
}

/// Delete everything inside `dir`, then the directory itself. Entry by entry rather
/// than one `remove_dir_all`, so a single locked file (a log an AV tool has open, say)
/// costs us that file instead of aborting the whole wipe.
fn purge_dir(dir: &Path, report: &mut RemovalReport) {
    let Ok(entries) = fs::read_dir(dir) else {
        return; // absent or unreadable — nothing to reclaim here
    };
    for entry in entries.flatten() {
        remove_with_retry(&entry.path(), report);
    }
    // Succeeds only once empty; anything that survived is already in `failed`.
    let _ = fs::remove_dir(dir);
}

/// The wipe itself, split out from the command so it is testable against temp dirs.
///
/// `recreate` re-creates the (now empty) directories, which the *reset* path needs:
/// the process keeps running, and tauri-plugin-sql creates its directory only once at
/// startup — a reload into the wizard would otherwise fail to reopen the database. The
/// quit path passes false so the folder is genuinely gone.
fn wipe(targets: &[PathBuf], recreate: bool) -> RemovalReport {
    let mut report = RemovalReport::default();
    for dir in targets {
        purge_dir(dir, &mut report);
    }
    if recreate {
        for dir in targets {
            let _ = fs::create_dir_all(dir);
        }
    }
    report
}

#[tauri::command]
pub async fn remove_all_app_data(
    app_handle: tauri::AppHandle,
    llama: tauri::State<'_, AppState>,
    process: tauri::State<'_, ProcessState>,
    recreate_dirs: bool,
) -> Result<RemovalReport, String> {
    // Stop everything still holding a handle on what we are about to delete. The GGUF
    // is memory-mapped by llama-server and Windows will not delete a mapped file at
    // all, so this ordering is load-bearing rather than tidy. A pipeline preset may
    // have left *two* models resident, so every server has to go, not just one.
    let _ = stop_all_servers(&llama);
    // An in-flight OCR job would write page images back into sessions/ *after* the
    // wipe; an in-flight download would do the same with its `.part`.
    request_cancel_processing(&process);
    cancel_setup();

    let data_dir = resolve_data_dir(&app_handle)?;
    let mut targets = vec![data_dir];

    // tauri-plugin-sql resolves `sqlite:workspace.db` against BaseDirectory::App — the
    // *config* dir, which on both supported platforms is the same directory as AppData.
    // Resolved separately anyway so the database is still covered on a platform where
    // the two diverge (Linux).
    if let Ok(config_dir) = app_handle.path().app_config_dir() {
        if !targets.contains(&config_dir) {
            targets.push(config_dir);
        }
    }

    // Only our own scratch subtree of the cache dir — never the cache dir itself. On
    // Windows that resolves to %LOCALAPPDATA%\<identifier>, which also holds the *live*
    // WebView2 profile; deleting that out from under the running webview would be both
    // impossible (locked) and destabilizing. The only user data the webview stores is
    // settings, which the frontend clears as part of the same action.
    if let Ok(cache_dir) = app_handle.path().app_cache_dir() {
        targets.push(cache_dir.join("ocr"));
    }

    // Deleting ~3.5 GB is disk-bound and takes seconds — keep it off the async runtime.
    tokio::task::spawn_blocking(move || wipe(&targets, recreate_dirs))
        .await
        .map_err(|error| format!("data removal task failed: {error}"))
}

/// Close the app immediately, bypassing Tauri's exit hooks. Used only by the
/// remove-and-quit path.
///
/// `AppHandle::exit` would let tauri-plugin-window-state run its save-on-exit hook,
/// which recreates the AppData directory (holding a fresh `.window-state.json`) moments
/// after the wipe emptied it — leaving a folder behind that the user was just told was
/// gone. Nothing here needs a graceful shutdown: llama-server was stopped by the wipe,
/// and the SQLite pool was closed by the frontend before it.
#[tauri::command]
pub fn quit_app() {
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A data dir standing in for AppData: a nested subtree plus a loose file.
    fn populate(root: &Path) -> u64 {
        fs::create_dir_all(root.join("models")).unwrap();
        fs::create_dir_all(root.join("binaries")).unwrap();
        fs::write(root.join("models").join("model.gguf"), vec![0u8; 2048]).unwrap();
        fs::write(root.join("binaries").join("llama-server"), vec![0u8; 512]).unwrap();
        fs::write(root.join("workspace.db"), vec![0u8; 64]).unwrap();
        2048 + 512 + 64
    }

    #[test]
    fn entry_size_sums_a_whole_subtree() {
        let dir = tempfile::tempdir().unwrap();
        let total = populate(dir.path());
        assert_eq!(entry_size(dir.path()), total);
        assert_eq!(entry_size(&dir.path().join("workspace.db")), 64);
        // A path that doesn't exist contributes nothing rather than erroring.
        assert_eq!(entry_size(&dir.path().join("nope")), 0);
    }

    #[test]
    fn wipe_removes_every_target_and_reports_what_it_freed() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("appdata");
        let cache = temp.path().join("cache").join("ocr");
        fs::create_dir_all(&cache).unwrap();
        let data_bytes = populate(&data);
        fs::write(cache.join("page-1.png"), vec![0u8; 128]).unwrap();

        let report = wipe(&[data.clone(), cache.clone()], false);

        assert!(!data.exists(), "the data dir itself must be gone");
        assert!(!cache.exists(), "the ocr scratch dir must be gone");
        assert_eq!(report.freed_bytes, data_bytes + 128);
        assert!(report.failed.is_empty());
    }

    #[test]
    fn wipe_recreates_empty_directories_for_the_reset_path() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("appdata");
        populate(&data);

        let report = wipe(std::slice::from_ref(&data), true);

        assert!(
            data.is_dir(),
            "the reset path needs the directory to survive"
        );
        assert_eq!(
            fs::read_dir(&data).unwrap().count(),
            0,
            "recreated, not preserved — the contents must still be gone"
        );
        assert!(report.failed.is_empty());
    }

    #[test]
    fn wipe_tolerates_targets_that_are_not_there() {
        let temp = tempfile::tempdir().unwrap();
        // A machine where setup never ran has no data dir at all; that is a clean
        // no-op, not an error.
        let report = wipe(&[temp.path().join("never-existed")], false);
        assert_eq!(report.freed_bytes, 0);
        assert!(report.failed.is_empty());
    }
}
