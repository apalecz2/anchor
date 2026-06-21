//! llama.cpp server lifecycle.
//!
//! Owns the spawned `llama-server` child process via [`AppState`] and exposes
//! commands to resolve its path, start it, query its health/liveness, and stop it.
//! The process is killed on main-window close (wired up in `lib.rs`), and any
//! server orphaned by a crash/`taskkill` of the app is reaped on next startup
//! ([`sweep_orphan_server`]).
//!
//! The server binds a freshly-chosen ephemeral port (not a hardcoded 8080) so it
//! can never collide with — or be confused for — an unrelated process already on a
//! well-known port; the chosen port is handed back to the frontend so every health
//! check and request targets the server we actually spawned.

use std::{
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use serde::Serialize;

use crate::paths::{llama_exe_name, resolve_data_dir};
use crate::setup::read_persisted_backend;

const DEFAULT_CTX_SIZE: &str = "8192";
const DEFAULT_IMAGE_MIN_TOKENS: &str = "1024";
const DEFAULT_N_PARALLEL: &str = "1";

/// Records the running server's PID + port under AppData so a server orphaned by a
/// crash (the app process dies without `stop`) can be reaped on the next launch.
const PIDFILE_NAME: &str = "llama-server.pid";

/// llama-server's combined stdout/stderr is redirected here (truncated each start)
/// so a release-build server window never pops up and its logs are still available
/// for diagnostics instead of being lost to an inherited, invisible console.
const LOG_RELATIVE_PATH: &[&str] = &["logs", "llama-server.log"];

pub struct AppState {
    pub llama_server: Mutex<Option<Child>>,
    /// Port the live server is bound to, surfaced to the frontend via
    /// [`get_llama_server_port`]. `None` when no server is running.
    pub port: Mutex<Option<u16>>,
    /// Absolute path of the PID file written for the live server, removed on a
    /// clean stop. `None` when no server is running.
    pub pidfile: Mutex<Option<PathBuf>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            llama_server: Mutex::new(None),
            port: Mutex::new(None),
            pidfile: Mutex::new(None),
        }
    }
}

/// Handle returned to the frontend after a successful start. The port lets the
/// webview build the correct `http://127.0.0.1:<port>` base URL.
#[derive(Serialize, Clone, Copy)]
pub struct ServerHandle {
    pub pid: u32,
    pub port: u16,
}

/// Ask the OS for a free TCP port by binding to port 0 and reading back the
/// assignment, then releasing it. There is an unavoidable (tiny) race between
/// release here and llama-server binding it; in practice the window is sub-millisecond
/// and the alternative — a hardcoded port — fails far more often (collisions, and
/// health checks passing against a *different* server already on that port).
fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("failed to find a free port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read chosen port: {error}"))?
        .port();
    Ok(port)
}

/// True if something is accepting connections on `127.0.0.1:port` right now. Used
/// to decide whether a recorded PID is still a live server worth reaping.
fn something_listening(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

/// Best-effort, OS-native force-kill of a process tree by PID. We don't hold a
/// `Child` handle for an orphan from a previous run, so we can't `.kill()` it.
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        // /T also terminates child processes spawned by llama-server.
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

/// Reap a llama-server left running by a previous app process that exited without
/// a clean stop (crash, `taskkill`, dev Ctrl-C) — otherwise it holds ~3 GB of RAM
/// indefinitely (docs/issues.md "Llama #1").
///
/// We only kill the recorded PID when a server is *actually still listening* on the
/// recorded port. That two-signal guard (PID + live listener on its ephemeral port)
/// makes it effectively impossible to kill an innocent process that merely inherited
/// a recycled PID. Called once at startup; safe when no PID file exists.
pub fn sweep_orphan_server(data_dir: &Path) {
    let pidfile = data_dir.join(PIDFILE_NAME);
    let Ok(contents) = std::fs::read_to_string(&pidfile) else {
        return;
    };

    let mut parts = contents.split_whitespace();
    let pid = parts.next().and_then(|s| s.parse::<u32>().ok());
    let port = parts.next().and_then(|s| s.parse::<u16>().ok());

    if let (Some(pid), Some(port)) = (pid, port) {
        if something_listening(port) {
            kill_pid(pid);
        }
    }

    let _ = std::fs::remove_file(&pidfile);
}

/// Stop the running server (if any), remove its PID file, and clear the recorded
/// port. Idempotent. Used by both the `stop_llama_server` command and the
/// main-window-close handler.
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

    if let Ok(mut pidfile) = state.pidfile.lock() {
        if let Some(path) = pidfile.take() {
            let _ = std::fs::remove_file(path);
        }
    }
    if let Ok(mut port) = state.port.lock() {
        *port = None;
    }

    Ok(())
}

#[tauri::command]
pub fn resolve_llama_server_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let binary = resolve_data_dir(&app_handle)?.join("binaries").join(llama_exe_name());
    if binary.exists() {
        Ok(binary.to_string_lossy().into_owned())
    } else {
        Err("llama-server not found — run the setup wizard to download it.".into())
    }
}

/// Current port the live server is bound to, or `None` if no server is running.
/// The frontend reads this to build its request base URL.
#[tauri::command]
pub fn get_llama_server_port(state: tauri::State<'_, AppState>) -> Option<u16> {
    state.port.lock().ok().and_then(|guard| *guard)
}

/// Liveness of the spawned child, distinguishing a still-loading server from a
/// crashed one. `"running"` = process alive (may still be loading the model),
/// `"exited"` = the process died (e.g. bad GGUF / OOM) — the frontend uses this to
/// fail fast instead of waiting out the whole readiness timeout, and `"stopped"` =
/// we never started one (or it was stopped cleanly).
#[tauri::command]
pub fn llama_server_status(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let mut llama_server = state
        .llama_server
        .lock()
        .map_err(|error| format!("failed to lock llama server state: {error}"))?;

    match llama_server.as_mut() {
        None => Ok("stopped".into()),
        Some(child) => match child
            .try_wait()
            .map_err(|error| format!("failed to inspect llama server state: {error}"))?
        {
            None => Ok("running".into()),
            Some(_) => Ok("exited".into()),
        },
    }
}

/// Whether a backend offloads to a GPU (and so warrants `--n-gpu-layers 999`).
/// `cpu` — and any unrecognized value — stays CPU-only.
fn is_gpu_backend(backend: &str) -> bool {
    matches!(backend, "cuda" | "rocm" | "metal")
}

#[tauri::command]
pub fn start_llama_server(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_path: String,
    mmproj_path: String,
    backend: String,
) -> Result<ServerHandle, String> {
    let mut llama_server = state
        .llama_server
        .lock()
        .map_err(|error| format!("failed to lock llama server state: {error}"))?;

    // Already running? Return the existing handle (port included) so the caller
    // keeps targeting the same server rather than spawning a duplicate.
    if let Some(child) = llama_server.as_mut() {
        if child
            .try_wait()
            .map_err(|error| format!("failed to inspect llama server state: {error}"))?
            .is_none()
        {
            let port = state
                .port
                .lock()
                .ok()
                .and_then(|guard| *guard)
                .ok_or_else(|| "server is running but its port is unknown".to_string())?;
            return Ok(ServerHandle { pid: child.id(), port });
        }
        // It exited; drop the stale handle and start a fresh one below.
        llama_server.take();
    }

    // Resolve the executable in Rust from AppData rather than trusting a path
    // supplied by the webview — accepting a frontend path would let XSS spawn an
    // arbitrary local binary. The model/mmproj args are only ever passed as data
    // to this fixed binary, never executed.
    let data_dir = resolve_data_dir(&app_handle)?;
    let llama_server_path = data_dir.join("binaries").join(llama_exe_name());
    if !llama_server_path.exists() {
        return Err("llama-server not found — run the setup wizard to download it.".into());
    }

    // Resolve the *effective* backend. The frontend passes its localStorage value,
    // which on a packaged build whose per-origin store never saw the wizard defaults to
    // `cpu` — which would force `--n-gpu-layers 0` (CPU-only generation) even with a GPU
    // build installed. So a non-GPU value is upgraded from the backend persisted to
    // AppData by the wizard, making the on-disk install the source of truth (the same
    // principle as the model-path heal) rather than fragile per-origin webview storage.
    let effective_backend = if is_gpu_backend(&backend) {
        backend.clone()
    } else {
        read_persisted_backend(&data_dir).unwrap_or_else(|| backend.clone())
    };
    let gpu_layers = if is_gpu_backend(&effective_backend) { "999" } else { "0" };

    let port = pick_free_port()?;

    // Redirect the server's output to a truncated log file so (a) no console window
    // appears in release on Windows and (b) crash diagnostics survive.
    let log_path: PathBuf = LOG_RELATIVE_PATH.iter().fold(data_dir.clone(), |p, seg| p.join(seg));
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let (stdout, stderr) = match std::fs::File::create(&log_path) {
        Ok(mut file) => {
            // Record the launch decision at the top of the log so the backend actually
            // in effect (and whether layers will offload) is diagnosable without guessing
            // from token rates. The child appends its own output after this line.
            use std::io::Write as _;
            let _ = writeln!(
                file,
                "[artifact] launching llama-server: requested_backend={backend} effective_backend={effective_backend} n_gpu_layers={gpu_layers}",
            );
            let err = file.try_clone().map(Stdio::from).unwrap_or_else(|_| Stdio::null());
            (Stdio::from(file), err)
        }
        // If the log file can't be created, fall back to discarding output rather
        // than inheriting a (potentially window-spawning) console.
        Err(_) => (Stdio::null(), Stdio::null()),
    };

    let mut command = Command::new(&llama_server_path);
    command
        .arg("-m")
        .arg(model_path)
        .arg("--mmproj")
        .arg(mmproj_path)
        .arg("--image-min-tokens")
        .arg(DEFAULT_IMAGE_MIN_TOKENS)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(DEFAULT_CTX_SIZE)
        .arg("--n-gpu-layers")
        .arg(gpu_layers)
        .arg("--parallel")
        .arg(DEFAULT_N_PARALLEL)
        .stdout(stdout)
        .stderr(stderr);

    // Suppress the console window llama-server would otherwise flash on Windows
    // release builds (the app itself is a GUI subsystem binary, so the child
    // inherits no console and Windows would allocate a visible one without this).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("failed to spawn llama server: {error}"))?;

    let pid = child.id();

    // Record PID + port so a future launch can reap this server if we crash before
    // a clean stop. Written before we hand back control to the frontend.
    let pidfile = data_dir.join(PIDFILE_NAME);
    let _ = std::fs::write(&pidfile, format!("{pid} {port}"));

    *llama_server = Some(child);
    if let Ok(mut port_guard) = state.port.lock() {
        *port_guard = Some(port);
    }
    if let Ok(mut pidfile_guard) = state.pidfile.lock() {
        *pidfile_guard = Some(pidfile);
    }

    Ok(ServerHandle { pid, port })
}

#[tauri::command]
pub fn stop_llama_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    stop_llama_server_process(&state)
}
