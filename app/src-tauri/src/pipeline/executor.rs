//! Walks a preset's steps for one page.
//!
//! This is the manifest-driven replacement for the orchestration currently living in
//! `app/src/features/llama/useLlamaChat.ts`. It derives the prompt inputs, ensures
//! the right model is resident, streams the completion, and hands back a
//! [`PageArtifact`].
//!
//! # What stays in TypeScript
//!
//! Provenance matching and confidence scoring. They are pure, heavily tested, and
//! have no residency or cancellation concerns, so the seam is drawn just before
//! them: the executor returns the *inputs* those stages need — the sanitized words
//! the model was actually shown, the raw output, and per-token logprobs with UTF-16
//! offsets — and the frontend scores them exactly as it does today.
//!
//! # Status
//!
//! Registered but not yet called by the UI; the TypeScript path remains the default
//! while the two are compared. Steps that no shipped preset uses yet
//! (`GroundModel`, `Verify`) report a clear error rather than pretending to run.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use crate::llama::{ensure_server, AppState, LaunchSpec};
use crate::ocr::OcrWord;
use crate::pipeline::budget::{estimate_budget, resolve_max_tokens};
use crate::pipeline::catalog::{self, Grounding, ModelSpec, PipelinePreset, Residency, Step};
use crate::pipeline::client::{
    build_request_body, stream_completion, ContentPart, TokenLogprob, CANCELLED_MESSAGE,
};
use crate::pipeline::prompt::{build_table_text, sanitize_words_for_provenance};

/// Text deltas are coalesced to this interval. Each emit is a JSON serialize plus an
/// IPC post, and a table can run to thousands of tokens — matching `setup.rs`'s
/// download-progress throttle keeps the stream readable without flooding the webview.
const DELTA_THROTTLE: Duration = Duration::from_millis(100);

/// How long to wait for a freshly-spawned server to report healthy. A cold load of a
/// multi-GB model on a slow disk genuinely takes minutes.
const READINESS_TIMEOUT: Duration = Duration::from_secs(180);
const READINESS_POLL: Duration = Duration::from_millis(500);

/// Everything the scoring stages need from one page's run.
#[derive(Serialize, Debug)]
pub struct PageArtifact {
    pub run_id: u64,
    pub preset_id: String,
    pub preset_version: u32,
    /// Box granularity of whatever grounded this page, so the frontend knows how
    /// precisely a cell can be traced back and renders highlights accordingly.
    pub grounding: Grounding,
    /// The words the model was actually shown, in the order it saw them. Returned
    /// rather than re-derived so provenance matches against exactly this list.
    pub grounded_items: Vec<OcrWord>,
    pub raw_model_output: String,
    pub logprobs: Vec<TokenLogprob>,
    pub finish_reason: Option<String>,
    /// The model hit its token budget before finishing the table.
    pub truncated: bool,
    /// The prompt left too little of the context window for a complete table.
    pub context_overflow: bool,
}

/// Emitted as each step begins, so the progress UI can describe the actual pipeline
/// rather than a fixed list of stages.
#[derive(Serialize, Clone)]
struct StepEvent {
    run_id: u64,
    page_index: u32,
    step_index: usize,
    kind: &'static str,
    label: String,
}

/// A streamed text delta. Deltas, not the accumulated content: sending the whole
/// string each time is quadratic in bytes over IPC.
#[derive(Serialize, Clone)]
struct DeltaEvent {
    run_id: u64,
    page_index: u32,
    step_index: usize,
    seq: u64,
    text_delta: String,
}

struct ActiveRun {
    id: u64,
    token: CancellationToken,
}

/// Tracks the one in-flight pipeline run.
///
/// The run id and the cancellation token do different jobs and both are needed: the
/// token aborts work in progress, while the monotonic id lets a late result from a
/// superseded run be recognised and discarded.
pub struct PipelineState {
    current: Mutex<Option<ActiveRun>>,
    next_id: AtomicU64,
}

impl PipelineState {
    pub fn new() -> Self {
        PipelineState {
            current: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    /// Start a run, cancelling any run still in flight. Returns its id and token.
    fn begin(&self) -> (u64, CancellationToken) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let token = CancellationToken::new();
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = current.take() {
            previous.token.cancel();
        }
        *current = Some(ActiveRun {
            id,
            token: token.clone(),
        });
        (id, token)
    }

    /// Clear the active run, but only if it is still the one that finished — a newer
    /// run must not be forgotten by an older one's cleanup.
    fn finish(&self, id: u64) {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_ref().is_some_and(|run| run.id == id) {
            *current = None;
        }
    }

    pub fn cancel_current(&self) {
        let current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(run) = current.as_ref() {
            run.token.cancel();
        }
    }
}

impl Default for PipelineState {
    fn default() -> Self {
        Self::new()
    }
}

/// Human-readable step name for the progress UI.
fn step_label(step: &Step) -> String {
    match step {
        Step::Render { .. } => "Reading the page".into(),
        Step::GroundTesseract { .. } => "Finding text on the page".into(),
        Step::GroundModel { model_id, .. } => match catalog::model(model_id) {
            Some(m) => format!("Reading the page ({})", m.label),
            None => "Reading the page".into(),
        },
        Step::Structure { model_id, .. } => match catalog::model(model_id) {
            Some(m) => format!("Building the table ({})", m.label),
            None => "Building the table".into(),
        },
        Step::Verify { model_id, .. } => match catalog::model(model_id) {
            Some(m) => format!("Checking the table ({})", m.label),
            None => "Checking the table".into(),
        },
    }
}

fn step_kind(step: &Step) -> &'static str {
    match step {
        Step::Render { .. } => "render",
        Step::GroundTesseract { .. } => "ground_tesseract",
        Step::GroundModel { .. } => "ground_model",
        Step::Structure { .. } => "structure",
        Step::Verify { .. } => "verify",
    }
}

/// Read a page image as a `data:` URL for the chat content part.
fn image_data_url(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("failed to read the page image: {e}"))?;
    let mime = if path.to_ascii_lowercase().ends_with(".jpg")
        || path.to_ascii_lowercase().ends_with(".jpeg")
    {
        "image/jpeg"
    } else {
        "image/png"
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Resolve a model's files to absolute paths under the AppData models directory.
fn launch_spec_for(model: &ModelSpec, data_dir: &std::path::Path) -> Result<LaunchSpec, String> {
    let models_dir = data_dir.join("models");
    let file_path = |role| {
        model.file(role).map(|f| {
            models_dir
                .join(f.relative_path)
                .to_string_lossy()
                .into_owned()
        })
    };

    let model_path = file_path(catalog::FileRole::Weights)
        .ok_or_else(|| format!("model `{}` has no weights file", model.id))?;

    Ok(LaunchSpec {
        model_path,
        mmproj_path: file_path(catalog::FileRole::Mmproj),
        ctx: model.launch.ctx,
        image_min_tokens: model.launch.image_min_tokens,
        parallel: model.launch.parallel,
        gpu_layers: model.launch.gpu_layers,
        jinja: model.launch.jinja,
        chat_template_file: file_path(catalog::FileRole::ChatTemplate),
        alias: model.launch.alias.map(str::to_owned),
    })
}

/// Whether a `/health` response body is llama.cpp's `{"status":"ok"}`.
///
/// A 200 alone is not proof the responder is *our* server. The port is ephemeral and
/// released a moment before the spawn binds it, so an unrelated local service can
/// occupy it in between — and streaming completions at an impostor would be worse
/// than failing to start. Split out from the polling loop so the check itself is
/// testable without a socket.
fn is_healthy_body(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|body| {
            body.get("status")
                .and_then(|s| s.as_str())
                .map(|s| s == "ok")
        })
        .unwrap_or(false)
}

/// Poll `/health` until the server answers, or the run is cancelled.
async fn wait_for_health(base_url: &str, token: &CancellationToken) -> Result<(), String> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + READINESS_TIMEOUT;

    while Instant::now() < deadline {
        if token.is_cancelled() {
            return Err(CANCELLED_MESSAGE.into());
        }
        if let Ok(response) = client.get(format!("{base_url}/health")).send().await {
            if response.status().is_success() {
                if let Ok(text) = response.text().await {
                    if is_healthy_body(&text) {
                        return Ok(());
                    }
                }
            }
        }
        tokio::select! {
            biased;
            _ = token.cancelled() => return Err(CANCELLED_MESSAGE.into()),
            _ = tokio::time::sleep(READINESS_POLL) => {}
        }
    }
    Err("the model server did not become ready in time".into())
}

/// Run one page through a preset.
#[allow(clippy::too_many_arguments)]
async fn run_page(
    app_handle: &tauri::AppHandle,
    servers: &AppState,
    preset: &PipelinePreset,
    run_id: u64,
    token: &CancellationToken,
    page_index: u32,
    image_path: &str,
    words: &[OcrWord],
    natural_height: i32,
    backend: &str,
    boost_tokens: bool,
) -> Result<PageArtifact, String> {
    let data_dir = crate::paths::resolve_data_dir(app_handle)?;

    // Filled in by the grounding step, consumed by the structuring step.
    let mut grounded: Vec<OcrWord> = Vec::new();
    let mut spatial_text = String::new();
    let mut artifact: Option<PageArtifact> = None;

    for (step_index, step) in preset.steps.iter().enumerate() {
        if token.is_cancelled() {
            return Err(CANCELLED_MESSAGE.into());
        }

        let _ = app_handle.emit(
            "pipeline:step",
            StepEvent {
                run_id,
                page_index,
                step_index,
                kind: step_kind(step),
                label: step_label(step),
            },
        );

        match step {
            // Rendering and Tesseract already ran in `process_document`; their
            // results arrive as this call's arguments. Splitting them out is what
            // lets the executor be async while pdfium stays on a blocking thread.
            Step::Render { .. } => {}

            Step::GroundTesseract { .. } => {
                grounded = sanitize_words_for_provenance(words, natural_height);
                spatial_text = build_table_text(&grounded, natural_height);
            }

            Step::Structure {
                model_id, prompt, ..
            }
            | Step::Verify {
                model_id, prompt, ..
            } => {
                let model = catalog::model(model_id)
                    .ok_or_else(|| format!("unknown model `{model_id}`"))?;

                let prompt_text = format!("{}{}", catalog::prompt_text(*prompt), spatial_text);
                let budget = estimate_budget(model, &prompt_text);
                let max_tokens = resolve_max_tokens(budget, grounded.len(), boost_tokens);

                let spec = launch_spec_for(model, &data_dir)?;
                let handle =
                    ensure_server(app_handle, servers, &spec, backend, Residency::Exclusive)?;
                let base_url = format!("http://127.0.0.1:{}", handle.port);
                wait_for_health(&base_url, token).await?;

                let body = build_request_body(
                    model,
                    vec![
                        ContentPart::ImageUrl(image_data_url(image_path)?),
                        ContentPart::Text(prompt_text),
                    ],
                    max_tokens,
                );

                // Coalesce deltas: one IPC post per DELTA_THROTTLE, carrying whatever
                // accumulated since the last one.
                let mut pending = String::new();
                let mut seq = 0u64;
                let mut last_emit = Instant::now()
                    .checked_sub(DELTA_THROTTLE)
                    .unwrap_or_else(Instant::now);

                let result = stream_completion(&base_url, body, token, |delta| {
                    pending.push_str(delta);
                    if last_emit.elapsed() >= DELTA_THROTTLE {
                        seq += 1;
                        let _ = app_handle.emit(
                            "pipeline:delta",
                            DeltaEvent {
                                run_id,
                                page_index,
                                step_index,
                                seq,
                                text_delta: std::mem::take(&mut pending),
                            },
                        );
                        last_emit = Instant::now();
                    }
                })
                .await?;

                // Flush whatever the throttle held back, or the last tokens of the
                // table would never reach the UI.
                if !pending.is_empty() {
                    seq += 1;
                    let _ = app_handle.emit(
                        "pipeline:delta",
                        DeltaEvent {
                            run_id,
                            page_index,
                            step_index,
                            seq,
                            text_delta: pending,
                        },
                    );
                }

                artifact = Some(PageArtifact {
                    run_id,
                    preset_id: preset.id.to_owned(),
                    preset_version: preset.version,
                    grounding: preset.grounding(),
                    grounded_items: grounded.clone(),
                    truncated: result.finish_reason.as_deref() == Some("length"),
                    raw_model_output: result.content,
                    logprobs: result.logprobs,
                    finish_reason: result.finish_reason,
                    context_overflow: budget.overflow,
                });
            }

            Step::GroundModel { model_id, .. } => {
                return Err(format!(
                    "preset `{}` grounds on model `{model_id}`, which this build cannot run yet",
                    preset.id
                ));
            }
        }
    }

    artifact.ok_or_else(|| format!("preset `{}` produced no table", preset.id))
}

/// Run one page of a document through a pipeline preset.
///
/// Rendering and Tesseract have already happened in `process_document`; this takes
/// their output and drives the model steps.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_extraction_pipeline(
    app_handle: tauri::AppHandle,
    servers: tauri::State<'_, AppState>,
    pipeline: tauri::State<'_, PipelineState>,
    preset_id: Option<String>,
    page_index: u32,
    image_path: String,
    words: Vec<OcrWord>,
    natural_height: i32,
    backend: String,
    boost_tokens: Option<bool>,
) -> Result<PageArtifact, String> {
    let preset_id = preset_id.unwrap_or_else(|| catalog::DEFAULT_PRESET_ID.to_owned());
    let preset =
        catalog::preset(&preset_id).ok_or_else(|| format!("unknown preset `{preset_id}`"))?;

    let (run_id, token) = pipeline.begin();

    let result = run_page(
        &app_handle,
        &servers,
        preset,
        run_id,
        &token,
        page_index,
        &image_path,
        &words,
        natural_height,
        &backend,
        boost_tokens.unwrap_or(false),
    )
    .await;

    pipeline.finish(run_id);
    result
}

/// Cancel the in-flight run, if any. Safe to call when nothing is running.
#[tauri::command]
pub fn cancel_extraction_pipeline(pipeline: tauri::State<'_, PipelineState>) {
    pipeline.cancel_current();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::catalog::{GpuLayers, PromptId, TesseractSpec, TESSERACT_QWEN};

    #[test]
    fn step_labels_name_the_model_actually_running() {
        let structure = Step::Structure {
            model_id: "qwen3.5-4b",
            prompt: PromptId::QwenTsvExtract,
            residency: Residency::Exclusive,
        };
        assert_eq!(
            step_label(&structure),
            "Building the table (Qwen3.5 4B (vision))"
        );
        assert_eq!(step_kind(&structure), "structure");

        let ground = Step::GroundTesseract {
            tesseract: TesseractSpec {
                psm: 6,
                lang: "eng",
            },
        };
        assert_eq!(step_label(&ground), "Finding text on the page");
        assert_eq!(step_kind(&ground), "ground_tesseract");
    }

    /// An unknown model must degrade to a generic label rather than panicking on an
    /// unwrap — the progress UI is not worth crashing a run over.
    #[test]
    fn a_step_naming_an_unknown_model_still_produces_a_label() {
        let step = Step::Structure {
            model_id: "nonexistent",
            prompt: PromptId::QwenTsvExtract,
            residency: Residency::Exclusive,
        };
        assert_eq!(step_label(&step), "Building the table");
    }

    #[test]
    fn launch_spec_resolves_model_files_under_the_models_directory() {
        let data_dir = std::path::Path::new("/data");
        let spec = launch_spec_for(&catalog::QWEN_3_5_4B, data_dir).expect("spec");
        assert!(spec.model_path.contains("models"));
        assert!(spec.model_path.ends_with("Qwen3.5-4B-Q4_K_M.gguf"));
        assert!(spec
            .mmproj_path
            .as_ref()
            .unwrap()
            .ends_with("mmproj-F16.gguf"));
        // Qwen ships no chat template file, so the flag stays absent.
        assert!(spec.chat_template_file.is_none());
        assert_eq!(spec.ctx, 8192);
        assert!(matches!(spec.gpu_layers, GpuLayers::AllWhenGpu));
    }

    /// Carried over from the frontend's `checkLlamaServerHealth` test (CR:M8) when
    /// readiness moved into the executor. A 200 from *something* on the port is not
    /// the same as a 200 from llama-server.
    #[test]
    fn only_llama_cpps_health_shape_counts_as_ready() {
        assert!(is_healthy_body(r#"{"status":"ok"}"#));
        assert!(is_healthy_body(r#"{"status":"ok","slots_idle":1}"#));

        // An impostor that happened to grab the ephemeral port.
        assert!(!is_healthy_body(r#"{"status":"loading model"}"#));
        assert!(!is_healthy_body(r#"{"ok":true}"#));
        assert!(!is_healthy_body("OK"));
        assert!(!is_healthy_body("<html>It works!</html>"));
        assert!(!is_healthy_body(""));
        assert!(!is_healthy_body("null"));
    }

    #[test]
    fn image_data_url_reports_a_missing_file_rather_than_panicking() {
        let err = image_data_url("/definitely/not/here.png").unwrap_err();
        assert!(err.contains("failed to read the page image"));
    }

    #[test]
    fn image_data_url_encodes_bytes_with_the_right_mime() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("page.png");
        std::fs::write(&png, b"hello").unwrap();
        let url = image_data_url(png.to_str().unwrap()).unwrap();
        assert_eq!(url, "data:image/png;base64,aGVsbG8=");

        let jpg = dir.path().join("page.JPEG");
        std::fs::write(&jpg, b"hello").unwrap();
        assert!(image_data_url(jpg.to_str().unwrap())
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
    }

    // ---- run lifecycle ----

    #[test]
    fn run_ids_are_monotonic() {
        let state = PipelineState::new();
        let (first, _) = state.begin();
        state.finish(first);
        let (second, _) = state.begin();
        assert!(second > first);
    }

    /// Starting a run cancels the one it supersedes, so an abandoned extraction
    /// stops streaming instead of racing the new one.
    #[test]
    fn beginning_a_run_cancels_the_previous_one() {
        let state = PipelineState::new();
        let (_, first_token) = state.begin();
        assert!(!first_token.is_cancelled());

        let (_, second_token) = state.begin();
        assert!(first_token.is_cancelled());
        assert!(!second_token.is_cancelled());
    }

    #[test]
    fn cancel_current_cancels_the_active_run() {
        let state = PipelineState::new();
        let (_, token) = state.begin();
        state.cancel_current();
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancelling_with_no_active_run_is_a_no_op() {
        PipelineState::new().cancel_current(); // must not panic
    }

    /// An older run finishing must not clear a newer run's registration, or the
    /// newer one becomes uncancellable.
    #[test]
    fn a_stale_finish_does_not_clear_a_newer_run() {
        let state = PipelineState::new();
        let (first, _) = state.begin();
        let (_, second_token) = state.begin();

        state.finish(first); // late cleanup from the superseded run
        state.cancel_current();
        assert!(
            second_token.is_cancelled(),
            "newer run must still be cancellable"
        );
    }

    #[test]
    fn the_default_preset_is_runnable_by_this_executor() {
        // Every step kind the default preset uses must be one `run_page` handles;
        // an unhandled kind would only surface at runtime otherwise.
        for step in TESSERACT_QWEN.steps {
            assert!(
                matches!(
                    step,
                    Step::Render { .. } | Step::GroundTesseract { .. } | Step::Structure { .. }
                ),
                "unhandled step kind in the default preset: {}",
                step_kind(step)
            );
        }
    }
}
