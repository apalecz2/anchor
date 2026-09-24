//! llama.cpp server lifecycle.
//!
//! Owns the spawned `llama-server` child processes via [`AppState`] and exposes
//! commands to resolve the binary's path, start a server, query its health/liveness,
//! and stop it. Servers are killed on main-window close (wired up in `lib.rs`), and
//! any server orphaned by a crash/`taskkill` of the app is reaped on next startup
//! ([`sweep_orphan_server`]).
//!
//! Each server binds a freshly-chosen ephemeral port (not a hardcoded 8080) so it
//! can never collide with — or be confused for — an unrelated process already on a
//! well-known port; the chosen port is handed back to the frontend so every health
//! check and request targets the server we actually spawned.
//!
//! # Why a registry rather than one slot
//!
//! A manifest-driven pipeline may run two models over one page (one to ground the
//! page, a larger one to verify the table), which means the app has to be able to
//! *swap* models — and, where memory allows, hold two at once. So the state is a
//! registry keyed by [`LaunchKey`], not a single `Option<Child>`.
//!
//! The key is the full launch identity, not a model name: the same GGUF served at a
//! different context size is a different server. That matters because the previous
//! implementation returned whatever server happened to be running without checking
//! *what* it was serving — with one model that was merely redundant, but the moment
//! a second model exists it would silently answer from the wrong one.
//!
//! # The argv is typed, and that is the security boundary
//!
//! The binary is resolved here from AppData and never accepted from the webview, so
//! XSS can't point it at an arbitrary executable. [`LaunchSpec`] is deliberately a
//! struct of typed fields with **no free-form `extra_args`**: the type *is* the
//! flag allowlist, which is a stronger guarantee than filtering a string list.
//! Paths and template filenames are passed as data to that fixed binary.

use std::{
    io::{ErrorKind, Read},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::paths::{llama_exe_name, resolve_data_dir};
use crate::pipeline::catalog::{self, GpuLayers, Residency};
use crate::setup::read_persisted_backend;

/// PID files are named `llama-server-<slot>.pid`; the orphan sweep matches on this
/// prefix so it also reclaims the single `llama-server.pid` older versions wrote.
const PIDFILE_PREFIX: &str = "llama-server";
const PIDFILE_EXTENSION: &str = "pid";

/// Directory under AppData holding each server's redirected output.
const LOG_DIR: &str = "logs";

/// Upper bound on concurrently-running servers. Two is what the pipeline needs (a
/// grounding model and a structuring model resident together on a capable machine);
/// the cap exists so a bug in residency policy can't spawn multi-GB processes without
/// limit, and it keeps the per-slot pid/log filenames bounded.
const MAX_SERVERS: usize = 2;

/// Everything about a launch that changes what the server actually serves.
///
/// Two specs with equal keys are interchangeable, so a request for one can be
/// answered by the other. Context size is part of the identity on purpose: the same
/// weights at a different `-c` is a different server with a different KV budget.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LaunchKey {
    model_path: String,
    mmproj_path: Option<String>,
    ctx: u32,
    gpu_layers: u32,
    parallel: u32,
}

/// How to launch one `llama-server`. Typed per flag — see the module docs on why
/// there is no free-form argument list.
#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub model_path: String,
    /// Vision projector. `None` for a text-only model, which simply omits `--mmproj`.
    pub mmproj_path: Option<String>,
    pub ctx: u32,
    pub image_min_tokens: Option<u32>,
    pub parallel: u32,
    pub gpu_layers: GpuLayers,
    /// `--jinja`, to apply the model's embedded chat template.
    pub jinja: bool,
    /// Absolute path for `--chat-template-file`, when the model ships one.
    pub chat_template_file: Option<String>,
    /// `--alias`, when the model expects a specific served name.
    pub alias: Option<String>,
}

impl LaunchSpec {
    /// The launch spec for today's single-model path, taken from the catalog so the
    /// context size and image-token floor have exactly one definition.
    ///
    /// The executor will build this per step from the step's own model; until then
    /// this is the bridge that keeps the catalog honest — if its Qwen entry drifts
    /// from what actually gets launched, it drifts here first.
    pub fn qwen_default(model_path: String, mmproj_path: String) -> Self {
        let launch = catalog::QWEN_3_5_4B.launch;
        LaunchSpec {
            model_path,
            mmproj_path: Some(mmproj_path),
            ctx: launch.ctx,
            image_min_tokens: launch.image_min_tokens,
            parallel: launch.parallel,
            gpu_layers: launch.gpu_layers,
            jinja: launch.jinja,
            chat_template_file: None,
            alias: launch.alias.map(str::to_owned),
        }
    }

    fn key(&self, resolved_gpu_layers: u32) -> LaunchKey {
        LaunchKey {
            model_path: self.model_path.clone(),
            mmproj_path: self.mmproj_path.clone(),
            ctx: self.ctx,
            gpu_layers: resolved_gpu_layers,
            parallel: self.parallel,
        }
    }
}

/// One live server.
struct RunningServer {
    child: Child,
    port: u16,
    /// Index into the pid/log filename space, freed when the server stops.
    slot: usize,
    pidfile: PathBuf,
    key: LaunchKey,
}

pub struct AppState {
    /// Live servers, in start order. A `Vec` rather than a map because N is at most
    /// [`MAX_SERVERS`] and start order is what eviction wants.
    servers: Mutex<Vec<RunningServer>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            servers: Mutex::new(Vec::new()),
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

/// How long to wait for the peer to prove it is still there. A real llama-server
/// accepts and then waits for a request, so this elapses in full on the success path —
/// paid once, at startup, by [`sweep_orphan_server`].
const LIVENESS_READ_TIMEOUT: Duration = Duration::from_millis(150);

/// True if something is accepting connections on `127.0.0.1:port` right now. Used
/// to decide whether a recorded PID is still a live server worth reaping.
///
/// **A successful `connect` is not proof of a listener.** On macOS loopback the call
/// returns `Ok` optimistically for a port nothing is bound to, and the connection is
/// reset immediately afterwards — the socket is already `CLOSED` by the time anyone
/// looks at it. `lsof` on such a port shows only our own half of a dead connection.
///
/// That false positive matters because of the one caller: [`sweep_orphan_server`]
/// force-kills the recorded PID when this returns true, and this check is the *only*
/// thing standing between that `kill -9` and an innocent process that happened to
/// inherit a recycled PID. Trusting `connect` alone collapsed that two-signal guard
/// down to one.
///
/// So the connection has to survive a read. A live server holds it open with nothing
/// to say, which times out; a reset socket reports EOF or `ECONNRESET` at once. The
/// bias is deliberate — a false negative merely leaves an orphan holding RAM until the
/// next launch, while a false positive kills someone else's process.
fn something_listening(port: u16) -> bool {
    let Ok(stream) = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    ) else {
        return false;
    };

    if stream
        .set_read_timeout(Some(LIVENESS_READ_TIMEOUT))
        .is_err()
    {
        return false;
    }

    match (&stream).read(&mut [0u8; 1]) {
        // Nothing to read and the connection is still up: someone is holding it open.
        Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => true,
        // The peer volunteered bytes, so it is unambiguously alive.
        Ok(n) if n > 0 => true,
        // `Ok(0)` is EOF and any other error is a reset: nothing was really there.
        _ => false,
    }
}

/// Best-effort, OS-native force-kill of a process tree by PID. We don't hold a
/// `Child` handle for an orphan from a previous run, so we can't `.kill()` it.
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // /T also terminates child processes spawned by llama-server.
        // CREATE_NO_WINDOW so reaping an orphan at startup doesn't flash a console.
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

fn pidfile_path(data_dir: &Path, slot: usize) -> PathBuf {
    data_dir.join(format!("{PIDFILE_PREFIX}-{slot}.{PIDFILE_EXTENSION}"))
}

fn log_path(data_dir: &Path, slot: usize) -> PathBuf {
    data_dir
        .join(LOG_DIR)
        .join(format!("{PIDFILE_PREFIX}-{slot}.log"))
}

/// Whether a filename is one of our PID files.
///
/// Matches the legacy un-slotted `llama-server.pid` as well as `llama-server-N.pid`,
/// so upgrading over an install that crashed with the old naming still reaps its
/// orphan instead of leaking multiple GB until the file is manually removed.
fn is_pidfile_name(name: &str) -> bool {
    name.starts_with(PIDFILE_PREFIX) && name.ends_with(PIDFILE_EXTENSION) && {
        let middle = &name[PIDFILE_PREFIX.len()..name.len() - PIDFILE_EXTENSION.len()];
        middle == "." || (middle.starts_with('-') && middle.ends_with('.'))
    }
}

/// Reap llama-servers left running by a previous app process that exited without a
/// clean stop (crash, `taskkill`, dev Ctrl-C) — otherwise each holds multiple GB of
/// RAM indefinitely (docs/issues.md "Llama #1").
///
/// We only kill a recorded PID when a server is *actually still listening* on the
/// recorded port. That two-signal guard (PID + live listener on its ephemeral port)
/// makes it effectively impossible to kill an innocent process that merely inherited
/// a recycled PID. Called once at startup; safe when no PID file exists.
pub fn sweep_orphan_server(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_pidfile_name(name) {
            continue;
        }

        let path = entry.path();
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if let (Some(pid), Some(port)) = parse_pidfile(&contents) {
                if something_listening(port) {
                    kill_pid(pid);
                }
            }
        }
        let _ = std::fs::remove_file(&path);
    }
}

/// Kill one server and remove its PID file.
///
/// The `wait` is load-bearing on Windows, not tidiness: the GGUF is memory-mapped by
/// the child, and the file cannot be deleted — nor the next model loaded into the
/// freed RAM — until the process has actually gone.
fn terminate(server: &mut RunningServer) {
    let _ = server.child.kill();
    let _ = server.child.wait();
    let _ = std::fs::remove_file(&server.pidfile);
}

/// Stop every running server. Idempotent.
///
/// Called by the `stop_llama_server` command, the main-window-close handler, and
/// `reset.rs` before wiping AppData — the last of which depends on every mapped GGUF
/// handle being released first.
pub fn stop_all_servers(state: &AppState) -> Result<(), String> {
    let mut servers = state
        .servers
        .lock()
        .map_err(|error| format!("failed to lock llama server state: {error}"))?;

    for mut server in servers.drain(..) {
        terminate(&mut server);
    }
    Ok(())
}

#[tauri::command]
pub fn resolve_llama_server_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let binary = resolve_data_dir(&app_handle)?
        .join("binaries")
        .join(llama_exe_name());
    if binary.exists() {
        Ok(binary.to_string_lossy().into_owned())
    } else {
        Err("llama-server not found. Run the setup wizard to download it.".into())
    }
}

/// Port of the most recently started live server, or `None` if none is running.
/// The frontend reads this to build its request base URL.
#[tauri::command]
pub fn get_llama_server_port(state: tauri::State<'_, AppState>) -> Option<u16> {
    let mut servers = state.servers.lock().ok()?;
    // `try_wait` needs `&mut`, so this is an explicit loop rather than `find`.
    for server in servers.iter_mut().rev() {
        if matches!(server.child.try_wait(), Ok(None)) {
            return Some(server.port);
        }
    }
    None
}

/// Liveness of the spawned children, distinguishing a still-loading server from a
/// crashed one. `"running"` = at least one process alive (it may still be loading the
/// model), `"exited"` = every server we started has died (e.g. bad GGUF / OOM) — the
/// frontend uses this to fail fast instead of waiting out the whole readiness timeout —
/// and `"stopped"` = we never started one (or they were stopped cleanly).
#[tauri::command]
pub fn llama_server_status(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let mut servers = state
        .servers
        .lock()
        .map_err(|error| format!("failed to lock llama server state: {error}"))?;

    if servers.is_empty() {
        return Ok("stopped".into());
    }

    let mut any_alive = false;
    for server in servers.iter_mut() {
        // `try_wait` yields `None` while the process is still running.
        let still_running = server
            .child
            .try_wait()
            .map_err(|error| format!("failed to inspect llama server state: {error}"))?
            .is_none();
        any_alive |= still_running;
    }

    Ok(if any_alive { "running" } else { "exited" }.into())
}

/// Parse a PID file ("`<pid> <port>`", whitespace-separated) into its PID and port.
/// Pure so the orphan-reaper's parsing is testable without a process. A
/// malformed/short line yields `None` for the missing field.
///
/// The on-disk *format* is deliberately unchanged from the single-server era — only
/// the filename gained a slot — so an upgrade can still read what a previous version
/// wrote.
fn parse_pidfile(contents: &str) -> (Option<u32>, Option<u16>) {
    let mut parts = contents.split_whitespace();
    let pid = parts.next().and_then(|s| s.parse::<u32>().ok());
    let port = parts.next().and_then(|s| s.parse::<u16>().ok());
    (pid, port)
}

/// Whether a backend offloads to a GPU (and so warrants `--n-gpu-layers 999`).
/// `cpu` — and any unrecognized value — stays CPU-only.
fn is_gpu_backend(backend: &str) -> bool {
    matches!(backend, "cuda" | "rocm" | "metal")
}

/// Turn the catalog's policy into the number `--n-gpu-layers` receives.
fn resolve_gpu_layers(policy: GpuLayers, backend: &str) -> u32 {
    match policy {
        GpuLayers::AllWhenGpu => {
            if is_gpu_backend(backend) {
                999
            } else {
                0
            }
        }
        GpuLayers::Fixed(n) => n,
    }
}

/// Build the argument list for one launch.
///
/// Pure, so the exact argv is pinned by a unit test rather than only observable by
/// running a server. Flag order matches what the single-model implementation emitted,
/// and the optional flags append only when the spec asks for them — so a model that
/// wants none of them produces a byte-identical command line to before.
fn build_args(spec: &LaunchSpec, gpu_layers: u32, port: u16) -> Vec<String> {
    let mut args: Vec<String> = vec!["-m".into(), spec.model_path.clone()];

    if let Some(mmproj) = &spec.mmproj_path {
        args.push("--mmproj".into());
        args.push(mmproj.clone());
    }
    if let Some(min_tokens) = spec.image_min_tokens {
        args.push("--image-min-tokens".into());
        args.push(min_tokens.to_string());
    }

    args.push("--host".into());
    args.push("127.0.0.1".into());
    args.push("--port".into());
    args.push(port.to_string());
    args.push("-c".into());
    args.push(spec.ctx.to_string());
    args.push("--n-gpu-layers".into());
    args.push(gpu_layers.to_string());
    args.push("--parallel".into());
    args.push(spec.parallel.to_string());

    if let Some(alias) = &spec.alias {
        args.push("--alias".into());
        args.push(alias.clone());
    }
    if spec.jinja {
        args.push("--jinja".into());
    }
    if let Some(template) = &spec.chat_template_file {
        args.push("--chat-template-file".into());
        args.push(template.clone());
    }

    args
}

/// Lowest slot index not currently in use.
fn free_slot(servers: &[RunningServer]) -> usize {
    (0..)
        .find(|i| !servers.iter().any(|s| s.slot == *i))
        .unwrap()
}

/// Check that every file `spec` references actually exists before spawning anything.
///
/// Without this, a missing model/mmproj/template file (deleted by hand, a botched
/// setup, a preset whose assets never finished downloading) is only discovered by
/// `wait_for_health`'s readiness poll in the executor, which cannot tell "the model
/// path was never valid" apart from "still loading" — so the caller burns the full
/// readiness timeout for a failure that was knowable in a `stat()` call.
fn require_files_exist(spec: &LaunchSpec) -> Result<(), String> {
    let check = |path: &str, label: &str| -> Result<(), String> {
        if Path::new(path).is_file() {
            Ok(())
        } else {
            Err(format!(
                "{label} file not found at {path}. Re-run setup to reinstall it, \
                 or re-register the custom model in Settings \u{25b8} Models."
            ))
        }
    };
    check(&spec.model_path, "Model")?;
    if let Some(mmproj) = &spec.mmproj_path {
        check(mmproj, "Projector (mmproj)")?;
    }
    if let Some(template) = &spec.chat_template_file {
        check(template, "Chat template")?;
    }
    Ok(())
}

/// Ensure a server matching `spec` is running, and return its handle.
///
/// Reuses a live server with the same [`LaunchKey`]; otherwise spawns one. Under
/// [`Residency::Exclusive`] every other server is stopped first — the safe default on
/// a machine that can only hold one multi-GB model — while [`Residency::Shared`]
/// leaves the others in place, up to [`MAX_SERVERS`].
///
/// This is the primitive the pipeline executor will call per step; the
/// `start_llama_server` command is a thin wrapper over it.
pub fn ensure_server(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    spec: &LaunchSpec,
    backend: &str,
    residency: Residency,
) -> Result<ServerHandle, String> {
    let data_dir = resolve_data_dir(app_handle)?;

    // Resolve the executable in Rust from AppData rather than trusting a path
    // supplied by the webview — accepting a frontend path would let XSS spawn an
    // arbitrary local binary. The model/mmproj args are only ever passed as data
    // to this fixed binary, never executed.
    let llama_server_path = data_dir.join("binaries").join(llama_exe_name());
    if !llama_server_path.exists() {
        return Err("llama-server not found. Run the setup wizard to download it.".into());
    }
    require_files_exist(spec)?;

    // Resolve the *effective* backend. The frontend passes its localStorage value,
    // which on a packaged build whose per-origin store never saw the wizard defaults to
    // `cpu` — which would force `--n-gpu-layers 0` (CPU-only generation) even with a GPU
    // build installed. So a non-GPU value is upgraded from the backend persisted to
    // AppData by the wizard, making the on-disk install the source of truth (the same
    // principle as the model-path heal) rather than fragile per-origin webview storage.
    let effective_backend = if is_gpu_backend(backend) {
        backend.to_owned()
    } else {
        read_persisted_backend(&data_dir).unwrap_or_else(|| backend.to_owned())
    };
    let gpu_layers = resolve_gpu_layers(spec.gpu_layers, &effective_backend);
    let key = spec.key(gpu_layers);

    let mut servers = state
        .servers
        .lock()
        .map_err(|error| format!("failed to lock llama server state: {error}"))?;

    // Drop any server that has died, so a crashed one is replaced rather than
    // reported as live.
    let mut dead: Vec<RunningServer> = Vec::new();
    let mut index = 0;
    while index < servers.len() {
        let exited = matches!(servers[index].child.try_wait(), Ok(Some(_)));
        if exited {
            dead.push(servers.remove(index));
        } else {
            index += 1;
        }
    }
    for mut server in dead {
        let _ = std::fs::remove_file(&server.pidfile);
        let _ = server.child.wait();
    }

    // Already serving exactly this? Hand back the same server.
    //
    // The key comparison is the point: the previous implementation returned whichever
    // server was running without checking what it served, which silently answers from
    // the wrong model as soon as a preset uses more than one.
    if let Some(server) = servers.iter().find(|s| s.key == key) {
        return Ok(ServerHandle {
            pid: server.child.id(),
            port: server.port,
        });
    }

    if matches!(residency, Residency::Exclusive) {
        for mut server in servers.drain(..) {
            terminate(&mut server);
        }
    } else if servers.len() >= MAX_SERVERS {
        // Evict the oldest to make room rather than refusing the request.
        let mut oldest = servers.remove(0);
        terminate(&mut oldest);
    }

    let slot = free_slot(&servers);
    let port = pick_free_port()?;

    // Redirect the server's output to a per-slot log file so (a) no console window
    // appears in release on Windows, (b) crash diagnostics survive, and (c) a second
    // model can't truncate the first one's log out from under it.
    let log_path = log_path(&data_dir, slot);
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
                "[anchor] launching llama-server: slot={slot} model={} requested_backend={backend} effective_backend={effective_backend} n_gpu_layers={gpu_layers} ctx={}",
                spec.model_path, spec.ctx,
            );
            let err = file
                .try_clone()
                .map(Stdio::from)
                .unwrap_or_else(|_| Stdio::null());
            (Stdio::from(file), err)
        }
        // If the log file can't be created, fall back to discarding output rather
        // than inheriting a (potentially window-spawning) console.
        Err(_) => (Stdio::null(), Stdio::null()),
    };

    let mut command = Command::new(&llama_server_path);
    command
        .args(build_args(spec, gpu_layers, port))
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

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn llama server: {error}"))?;

    // llama-server rejecting the model outright (corrupt/unsupported quant, GPU init
    // failure, a lost port-bind race) crashes within tens of milliseconds. A short
    // grace period catches that now, before the caller pays the full readiness
    // timeout for a process that was never actually there. A model that is genuinely
    // loading survives this trivially -- nothing here waits on model load.
    let grace_deadline = Instant::now() + Duration::from_millis(300);
    let mut crash_status = None;
    while Instant::now() < grace_deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                crash_status = Some(status);
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => break,
        }
    }
    if let Some(status) = crash_status {
        return Err(format!(
            "llama-server exited immediately ({status}). The model file may be corrupt, \
             unsupported, or too large for available memory. See the log at {}.",
            log_path.display()
        ));
    }

    let pid = child.id();

    // Record PID + port so a future launch can reap this server if we crash before
    // a clean stop. Written before we hand back control to the frontend.
    let pidfile = pidfile_path(&data_dir, slot);
    let _ = std::fs::write(&pidfile, format!("{pid} {port}"));

    servers.push(RunningServer {
        child,
        port,
        slot,
        pidfile,
        key,
    });

    Ok(ServerHandle { pid, port })
}

#[tauri::command]
pub fn start_llama_server(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_path: String,
    mmproj_path: String,
    backend: String,
) -> Result<ServerHandle, String> {
    // The command surface still describes today's single-model path; the executor
    // will select a spec per pipeline step instead.
    let spec = LaunchSpec::qwen_default(model_path, mmproj_path);
    ensure_server(
        &app_handle,
        &state,
        &spec,
        &backend,
        // One model at a time, matching the behaviour this command has always had.
        Residency::Exclusive,
    )
}

#[tauri::command]
pub fn stop_llama_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    stop_all_servers(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> LaunchSpec {
        LaunchSpec::qwen_default("/models/qwen.gguf".into(), "/models/mmproj.gguf".into())
    }

    #[test]
    fn is_gpu_backend_matrix() {
        assert!(is_gpu_backend("cuda"));
        assert!(is_gpu_backend("rocm"));
        assert!(is_gpu_backend("metal"));
        assert!(!is_gpu_backend("cpu"));
        // Unknown/garbage stays CPU-only rather than risking --n-gpu-layers 999.
        assert!(!is_gpu_backend("vulkan"));
        assert!(!is_gpu_backend(""));
    }

    #[test]
    fn resolve_gpu_layers_follows_the_backend_for_the_all_when_gpu_policy() {
        assert_eq!(resolve_gpu_layers(GpuLayers::AllWhenGpu, "cuda"), 999);
        assert_eq!(resolve_gpu_layers(GpuLayers::AllWhenGpu, "metal"), 999);
        assert_eq!(resolve_gpu_layers(GpuLayers::AllWhenGpu, "cpu"), 0);
        assert_eq!(resolve_gpu_layers(GpuLayers::AllWhenGpu, "vulkan"), 0);
        // A fixed count ignores the backend entirely.
        assert_eq!(resolve_gpu_layers(GpuLayers::Fixed(42), "cpu"), 42);
    }

    #[test]
    fn parse_pidfile_reads_pid_and_port() {
        assert_eq!(parse_pidfile("4321 5599"), (Some(4321), Some(5599)));
        assert_eq!(parse_pidfile("  4321\t5599\n"), (Some(4321), Some(5599)));
    }

    #[test]
    fn parse_pidfile_tolerates_malformed_lines() {
        assert_eq!(parse_pidfile(""), (None, None));
        assert_eq!(parse_pidfile("4321"), (Some(4321), None)); // port missing
        assert_eq!(parse_pidfile("notanum 5599"), (None, Some(5599)));
        // A port that overflows u16 yields None for the port, not a panic.
        assert_eq!(parse_pidfile("4321 70000"), (Some(4321), None));
    }

    /// The sweep must reclaim orphans written by *older* builds too, or upgrading
    /// over a crashed install leaks multiple GB until the file is removed by hand.
    #[test]
    fn pidfile_names_cover_slotted_and_legacy_files() {
        assert!(is_pidfile_name("llama-server-0.pid"));
        assert!(is_pidfile_name("llama-server-11.pid"));
        assert!(is_pidfile_name("llama-server.pid")); // legacy, un-slotted
        assert!(!is_pidfile_name("llama-server-0.log"));
        assert!(!is_pidfile_name("llama-server.log"));
        assert!(!is_pidfile_name("other.pid"));
        assert!(!is_pidfile_name("llama-serverX.pid"));
    }

    #[test]
    fn pid_and_log_paths_are_per_slot() {
        let dir = Path::new("/data");
        assert!(pidfile_path(dir, 0).ends_with("llama-server-0.pid"));
        assert!(pidfile_path(dir, 1).ends_with("llama-server-1.pid"));
        assert!(log_path(dir, 0).ends_with("llama-server-0.log"));
        // Logs live under the logs/ subdirectory, pid files at the AppData root.
        assert!(log_path(dir, 0).parent().unwrap().ends_with(LOG_DIR));
    }

    /// The exact command line is a contract with llama.cpp, and it was previously
    /// pinned by nothing at all. These are the arguments the single-model
    /// implementation emitted, in its order.
    #[test]
    fn qwen_argv_matches_the_previous_single_model_command_line() {
        let args = build_args(&spec(), 999, 5599);
        assert_eq!(
            args,
            vec![
                "-m",
                "/models/qwen.gguf",
                "--mmproj",
                "/models/mmproj.gguf",
                "--image-min-tokens",
                "1024",
                "--host",
                "127.0.0.1",
                "--port",
                "5599",
                "-c",
                "8192",
                "--n-gpu-layers",
                "999",
                "--parallel",
                "1",
            ]
        );
    }

    /// Nothing optional leaks into a launch that didn't ask for it — that is what
    /// keeps the Qwen command line byte-identical to before.
    #[test]
    fn optional_flags_are_absent_unless_requested() {
        let args = build_args(&spec(), 0, 1234);
        for flag in ["--jinja", "--chat-template-file", "--alias"] {
            assert!(!args.contains(&flag.to_string()), "{flag} should be absent");
        }
        assert!(args.contains(&"--n-gpu-layers".to_string()));
        assert_eq!(
            args[args.iter().position(|a| a == "--n-gpu-layers").unwrap() + 1],
            "0"
        );
    }

    /// A text-only grounding model has no projector; omitting the flag (rather than
    /// passing an empty path) is what lets one launcher serve both kinds.
    #[test]
    fn a_model_without_a_projector_omits_the_mmproj_flag() {
        let mut s = spec();
        s.mmproj_path = None;
        s.image_min_tokens = None;
        let args = build_args(&s, 0, 1234);
        assert!(!args.contains(&"--mmproj".to_string()));
        assert!(!args.contains(&"--image-min-tokens".to_string()));
        assert_eq!(
            &args[0..2],
            &["-m".to_string(), "/models/qwen.gguf".to_string()]
        );
    }

    /// Surya's launch shape, as recovered in `prototypes/Surya`: its own alias, the
    /// embedded jinja template, a larger context, and no image-token floor.
    #[test]
    fn a_templated_model_emits_its_alias_and_template_flags() {
        let s = LaunchSpec {
            model_path: "/models/surya.gguf".into(),
            mmproj_path: Some("/models/surya-mmproj.gguf".into()),
            ctx: 32768,
            image_min_tokens: None,
            parallel: 1,
            gpu_layers: GpuLayers::AllWhenGpu,
            jinja: true,
            chat_template_file: Some("/models/chat_template.jinja".into()),
            alias: Some("surya-ocr-2".into()),
        };
        let args = build_args(&s, 999, 8099);
        assert!(args.contains(&"--jinja".to_string()));
        let alias_at = args.iter().position(|a| a == "--alias").unwrap();
        assert_eq!(args[alias_at + 1], "surya-ocr-2");
        let tpl_at = args
            .iter()
            .position(|a| a == "--chat-template-file")
            .unwrap();
        assert_eq!(args[tpl_at + 1], "/models/chat_template.jinja");
        let ctx_at = args.iter().position(|a| a == "-c").unwrap();
        assert_eq!(args[ctx_at + 1], "32768");
    }

    /// The launch key is what decides "is the running server the one I asked for".
    /// Every field that changes what the server serves must change the key, or a
    /// request would be answered from the wrong model.
    #[test]
    fn launch_key_covers_everything_that_changes_what_is_served() {
        let base = spec();
        let key = base.key(999);

        assert_eq!(key, base.key(999), "identical specs share a key");

        let mut other_model = base.clone();
        other_model.model_path = "/models/surya.gguf".into();
        assert_ne!(key, other_model.key(999));

        let mut other_ctx = base.clone();
        other_ctx.ctx = 32768;
        assert_ne!(key, other_ctx.key(999), "same weights, different KV budget");

        let mut other_mmproj = base.clone();
        other_mmproj.mmproj_path = None;
        assert_ne!(key, other_mmproj.key(999));

        let mut other_parallel = base.clone();
        other_parallel.parallel = 4;
        assert_ne!(key, other_parallel.key(999));

        // Resolved GPU layers differ when the backend does, so a CPU-started server
        // is not reused for a GPU request.
        assert_ne!(key, base.key(0));
    }

    /// Cosmetic-only fields must NOT split the key, or every launch would needlessly
    /// evict a server that is already serving the right thing.
    #[test]
    fn launch_key_ignores_fields_that_do_not_change_what_is_served() {
        let base = spec();
        let mut aliased = base.clone();
        aliased.alias = Some("something-else".into());
        assert_eq!(base.key(999), aliased.key(999));
    }

    #[test]
    fn qwen_default_spec_comes_from_the_catalog() {
        let s = spec();
        assert_eq!(s.ctx, catalog::QWEN_3_5_4B.launch.ctx);
        assert_eq!(
            s.image_min_tokens,
            catalog::QWEN_3_5_4B.launch.image_min_tokens
        );
        assert_eq!(s.parallel, catalog::QWEN_3_5_4B.launch.parallel);
        assert!(s.mmproj_path.is_some());
    }

    #[test]
    fn require_files_exist_rejects_a_missing_model_path() {
        let mut s = spec();
        s.model_path = "/definitely/not/a/real/model.gguf".into();
        let err = require_files_exist(&s).expect_err("missing model file must be rejected");
        assert!(err.contains("Model"), "{err}");
        assert!(err.contains(&s.model_path), "{err}");
    }

    #[test]
    fn require_files_exist_rejects_a_missing_mmproj_path() {
        // qwen_default's model_path won't exist on the test machine either, so use
        // a real file (this source file) to isolate the mmproj check.
        let mut s = spec();
        s.model_path = file!().into();
        s.mmproj_path = Some("/definitely/not/a/real/mmproj.gguf".into());
        let err = require_files_exist(&s).expect_err("missing mmproj file must be rejected");
        assert!(err.contains("Projector"), "{err}");
    }

    #[test]
    fn require_files_exist_passes_when_every_referenced_file_exists() {
        let mut s = spec();
        s.model_path = file!().into();
        s.mmproj_path = None;
        s.chat_template_file = None;
        assert!(require_files_exist(&s).is_ok());
    }

    #[test]
    fn free_slot_fills_the_lowest_gap() {
        // No servers: slot 0. With a live slot 0: slot 1. (Exercised through the
        // helper rather than real children, which would need spawned processes.)
        assert_eq!(free_slot(&[]), 0);
    }

    /// Serialises every test that takes an ephemeral port.
    ///
    /// These are the only places in the crate that bind a socket, and left to run
    /// concurrently they compete for the same ephemeral range: one releases the port
    /// `pick_free_port` just handed back, another asks for port 0 and is given that
    /// exact port. Symptoms were an `AddrInUse` on re-bind, or a probe finding a live
    /// listener on a port that had just been reported free.
    ///
    /// Serialising is the fix rather than retry-until-it-passes because the contention
    /// is entirely self-inflicted — nothing outside this binary is fighting for these
    /// ports, so removing the overlap removes the race outright.
    static PORT_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Poisoning here means a *sibling* port test already failed. Recovering the guard
    /// keeps that first failure legible instead of burying it under a second panic.
    fn port_test_guard() -> std::sync::MutexGuard<'static, ()> {
        PORT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Note what this does *not* assert: that the returned port is still free. It
    /// cannot — `pick_free_port` releases the port before returning it and says so, so
    /// its continued freedom is a property of the machine, not of this function. The
    /// previous version asserted exactly that (via `!something_listening`), which is
    /// why it failed intermittently for two unrelated reasons at once.
    #[test]
    fn pick_free_port_returns_a_port_from_the_ephemeral_range() {
        let _guard = port_test_guard();

        let port = pick_free_port().expect("should find a free port");
        assert!(port > 0);
        // Two calls in a row both succeed and stay in range — enough to catch a
        // regression that returned 0, a constant, or an error.
        let second = pick_free_port().expect("should find a second free port");
        assert!(second > 0);
    }

    #[test]
    fn something_listening_detects_a_live_listener() {
        let _guard = port_test_guard();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(something_listening(port));
    }

    /// The regression test for the false positive described on [`something_listening`].
    ///
    /// This failed roughly once in fifteen full-suite runs before the fix, and it was
    /// right to: `connect` to a dead loopback port returns `Ok` on macOS, so the old
    /// implementation reported a live server on a port nothing was bound to. The
    /// flakiness was the bug surfacing, not the test being unreliable — holding the
    /// probe socket open showed `lsof` listing only our own half of the connection,
    /// already `CLOSED`.
    ///
    /// Repeated over several ports because the failure it guards against is
    /// probabilistic — see the note on `something_listening_rejects_a_closed_listener`
    /// for how weak that makes these two as regression tests.
    #[test]
    fn something_listening_rejects_a_port_with_no_listener() {
        let _guard = port_test_guard();

        for _ in 0..10 {
            let port = pick_free_port().expect("should find a free port");
            assert!(
                !something_listening(port),
                "reported a live listener on port {port}, which nothing is bound to"
            );
        }
    }

    /// A listener that goes away must stop being reported as live, or
    /// `sweep_orphan_server` would skip reaping the very orphan it exists to clean up.
    ///
    /// **Honest limits of this as a regression test.** Reverting `something_listening`
    /// to its old `connect(..).is_ok()` form and running the full suite 40 times failed
    /// here once — and running this test *alone* 30 times never failed at all. The
    /// underlying quirk only shows up under the whole suite's concurrent port churn, so
    /// these two tests document the contract and will eventually catch a regression,
    /// but they will not catch one on the first run. The argument for the current
    /// implementation rests on it being correct by construction (a connection that
    /// cannot survive a read was never a live server), not on this test's teeth.
    #[test]
    fn something_listening_rejects_a_closed_listener() {
        let _guard = port_test_guard();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(something_listening(port));
        drop(listener);
        assert!(!something_listening(port));
    }

    /// The sweep reaps every PID file it finds and removes them, including a legacy
    /// un-slotted one. Uses ports nothing is listening on, so no process is killed —
    /// the assertion is about file reclamation, which is the part that leaks.
    #[test]
    fn sweep_removes_every_pidfile_it_finds() {
        let _guard = port_test_guard();
        let dir = tempfile::tempdir().expect("temp dir");

        let dead_port = pick_free_port().expect("free port");
        std::fs::write(
            dir.path().join("llama-server-0.pid"),
            format!("999999 {dead_port}"),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("llama-server.pid"),
            format!("999998 {dead_port}"),
        )
        .unwrap();
        // An unrelated file must survive.
        std::fs::write(dir.path().join("hardware_backend"), "cuda").unwrap();

        sweep_orphan_server(dir.path());

        assert!(!dir.path().join("llama-server-0.pid").exists());
        assert!(!dir.path().join("llama-server.pid").exists());
        assert!(dir.path().join("hardware_backend").exists());
    }

    #[test]
    fn sweep_is_safe_when_the_directory_has_no_pidfiles() {
        let dir = tempfile::tempdir().expect("temp dir");
        sweep_orphan_server(dir.path()); // must not panic
        sweep_orphan_server(Path::new("/definitely/not/a/real/dir"));
    }
}
