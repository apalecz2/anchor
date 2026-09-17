//! Document processing and OCR.
//!
//! Renders PDFs/images to PNGs, preprocesses them, and runs whichever classical
//! OCR engine the active preset names (`catalog::OcrEngine` — Tesseract or
//! oar-ocr), returning per-page text + word bounding boxes. Also owns Tesseract
//! environment configuration, which must run before a Tesseract-engine OCR call
//! (see [`configure_tesseract_env`]).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use pdfium_render::prelude::*;

use image::{DynamicImage, GenericImageView, GrayImage};

// oar-ocr (see prototypes/OarOcr): pure-Rust OCR via ONNX Runtime, one of the
// two engines `catalog::OcrEngine` can select. Aliased because oar-ocr's
// BoundingBox (a polygon) is a different type from this file's own
// BoundingBox (left/top/width/height).
use oar_ocr::prelude::*;
use oar_ocr::processors::BoundingBox as OarBox;

use tauri::{Emitter, Manager};

use crate::paths::pdfium_lib_name;
use crate::pipeline::catalog;

const MAX_FILE_SIZE_BYTES: u64 = 500 * 1024 * 1024; // 500 MB

/// Most pages one document may have. File size alone is no guard: a scanned book
/// can be thousands of mostly-blank pages and a few hundred MB, and each page costs
/// a 2000px pdfium render plus a Tesseract pass — order a second or two — so an
/// uncapped job runs for hours. The cap is a runaway/wrong-file guard, not a product
/// limit; nothing about the pipeline degrades before it. Split the PDF to go past it.
///
/// Typed `PdfPageIndex` (`u16`) on purpose — see [`validate_pdf_page_count`].
const MAX_PDF_PAGES: PdfPageIndex = 2_000;

/// The cap must stay well under the width of `PdfPageIndex`, because pdfium-render
/// narrows the real page count to that type before we ever see it (again, see
/// [`validate_pdf_page_count`]). Keeping a wide margin is what makes the wrap
/// unreachable for real input rather than merely unlikely. Compile-time, so raising
/// the cap toward `u16::MAX` fails the build instead of quietly re-opening it.
const _: () = assert!(MAX_PDF_PAGES < PdfPageIndex::MAX / 2);

/// Cancellation state for document processing. A long PDF can take minutes; without
/// this the user has no way to abort a 100-page job once it starts (design review
/// M13, and a prerequisite for the design's background queue, §6).
///
/// Cancellation uses a monotonic generation counter rather than a plain bool — the
/// same pattern the setup-download cancel uses (design §7.4). `process_document`
/// reads the generation once at entry and aborts the moment it changes between
/// pages, so a cancel can never accidentally apply to a *later* run that started
/// after the cancel was requested.
///
/// The counter is an `Arc<AtomicU64>` so the same atomic can be shared with the
/// `spawn_blocking` worker that does the actual render/OCR — the cancel command
/// (on the main thread) and the worker poll the same value.
pub struct ProcessState {
    generation: Arc<AtomicU64>,
}

impl ProcessState {
    pub fn new() -> Self {
        ProcessState {
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl Default for ProcessState {
    fn default() -> Self {
        Self::new()
    }
}

/// Request cancellation of any in-flight `process_document`. Bumping the generation
/// is enough: the running job notices the change between pages and stops. A no-op
/// when nothing is running (the next job reads the already-advanced value at entry).
///
/// Split from the command so other backend paths can request the same stop — the data
/// wipe (`reset.rs`) must halt OCR before deleting, or the job writes page images back
/// into a `sessions/` directory that was just removed.
pub fn request_cancel_processing(state: &ProcessState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub fn cancel_process_document(state: tauri::State<'_, ProcessState>) {
    request_cancel_processing(&state);
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct BoundingBox {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct OcrWord {
    /// Stable identifier, minted by the frontend rather than here — `CellProvenance`
    /// stores these ids, so they must survive edits that reorder the array.
    ///
    /// Absent on freshly-OCR'd words (nothing has named them yet) and carried
    /// through unchanged when the frontend sends words back into the pipeline. That
    /// round-trip is what keeps a stored `wordIds` resolvable: if the pipeline
    /// returned re-identified words, click-to-highlight would break on reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub text: String,
    pub confidence: f32,
    pub box_coords: BoundingBox,
}

#[derive(Serialize, Deserialize)]
pub struct DocumentPageResult {
    pub image_path: String, // generated PNG path
    pub natural_width: i32,
    pub natural_height: i32,
    pub words: Vec<OcrWord>,
    pub text: String,
    /// Set when this individual page failed to render or OCR. Document processing
    /// is per-page fault-tolerant: one bad page in a long PDF is recorded here and
    /// skipped rather than aborting the whole document, so the pages that did
    /// succeed are still usable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Progress for a multi-page document, emitted on the `process:progress` channel
/// after each page so the UI can show "Processing page x of y" instead of a static
/// spinner for minutes on a long PDF.
#[derive(Serialize, Clone)]
struct ProcessProgress {
    session_id: String,
    current_page: usize,
    total_pages: usize,
}

#[derive(Serialize, Deserialize)]
pub struct ExtractionResult {
    pub session_id: String,
    pub pages: Vec<DocumentPageResult>,
}

const UPSCALE_NARROW_SIDE_THRESHOLD: u32 = 1500;

/// The geometric scale applied before OCR: 2× Lanczos upscale when upscaling is
/// allowed (image-upload path only) and the narrow side is below the threshold,
/// else 1.0. Split out as a pure function so the decision and the coordinate
/// mapping that divides by it (see [`map_coord`]) are unit-testable (design §6.2a).
fn upscale_factor(width: u32, height: u32, allow_upscale: bool) -> f32 {
    if allow_upscale && width.min(height) < UPSCALE_NARROW_SIDE_THRESHOLD {
        2.0
    } else {
        1.0
    }
}

/// Map an OCR bounding-box coordinate from the (possibly upscaled) preprocessed
/// image back into the original image's coordinate space by dividing out the scale
/// factor. Pure so the round-trip is testable without running Tesseract.
fn map_coord(value: i32, scale: f32) -> i32 {
    (value as f32 / scale).round() as i32
}

/// How `process_document` dispatches on a file's (lowercased) extension. Pure so
/// the pdf/image/unsupported split is unit-testable.
#[derive(Debug, PartialEq, Eq)]
enum InputKind {
    Pdf,
    Image,
    Unsupported,
}

fn classify_extension(ext: &str) -> InputKind {
    match ext {
        "pdf" => InputKind::Pdf,
        "png" | "jpg" | "jpeg" => InputKind::Image,
        _ => InputKind::Unsupported,
    }
}

/// Decide whether a loaded PDF's page count is one we will process.
///
/// Rejects both ends. Zero is not a valid PDF — the spec requires a page tree with
/// at least one page — so a document pdfium opened but reports as empty is damaged,
/// and returning `Ok` with no pages is the worst outcome available: the frontend
/// writes a `document_page_sets` marker of 0 next to 0 page rows, which its
/// completeness check reads back as a *complete* cache, so the session shows an empty
/// document forever with no way to retry into it.
///
/// The upper bound is [`MAX_PDF_PAGES`].
///
/// Note what this can and cannot see. `PdfPages::len()` is
/// `FPDF_GetPageCount(..) as u16` inside pdfium-render, and the C function returns an
/// `int` — so the truncation happens upstream, before any cast of ours, and a
/// 70,000-page file arrives here already claiming 4,464. There is no way to detect
/// that through the crate's safe API (the `FPDF_DOCUMENT` handle needed to call
/// `FPDF_GetPageCount` ourselves is `pub(crate)`). The cap makes it moot for every
/// realistic input: a document large enough to wrap is rejected on the truncated
/// count too, unless it lands in 65,536..=67,535 pages exactly. That residual is
/// accepted, not fixed.
fn validate_pdf_page_count(page_count: PdfPageIndex) -> Result<(), String> {
    if page_count == 0 {
        return Err(
            "This PDF reports no pages. The file is likely damaged or incomplete.".to_string(),
        );
    }
    if page_count > MAX_PDF_PAGES {
        return Err(format!(
            "This PDF has {page_count} pages, more than the {MAX_PDF_PAGES}-page limit. \
             Split it into smaller files and extract them separately."
        ));
    }
    Ok(())
}

/// Name prefix for the per-run scratch directories under `<cache>/ocr/`. The sweep
/// matches on it, so only directories this module created are ever reclaimed.
const OCR_RUN_DIR_PREFIX: &str = "run-";

/// How long an `ocr/run-*` directory may sit before [`sweep_stale_ocr_work_dirs`]
/// treats it as the debris of a crashed run. Generous on purpose: the app has no
/// single-instance lock, so a second instance's startup sweep must never be able
/// to delete a *live* run's scratch dir out from under it. No document takes a day
/// to OCR; anything that old belongs to a process that is gone.
const OCR_RUN_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

/// Per-process counter that makes each run's scratch directory distinct.
static OCR_RUN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Name the scratch directory for one `process_document` run.
///
/// The preprocessed OCR copy inside is still named after its source file's stem,
/// which for an uploaded image is the *user's* filename — so the working path used
/// to be a pure function of that name and nothing else. Two runs over the same
/// filename then shared one path and deleted each other's file mid-OCR, which
/// ordinary single-user flows reach without any name coincidence: cancel-then-retry
/// (a cancel is fire-and-forget and an image OCR can't be interrupted, so the
/// abandoned run is still working when the retry starts), leaving and re-entering a
/// session while it processes, or the same file attached to two sessions. Isolating
/// each run in its own directory removes the shared path entirely.
///
/// All three components are needed: `seq` separates runs within a process, `pid`
/// separates concurrent app instances (there is no single-instance lock), and the
/// timestamp separates a reused pid after a restart. Pure so the format and its
/// uniqueness are testable without a Tauri app handle.
fn ocr_run_dir_name(pid: u32, seq: u64, timestamp_ms: u128) -> String {
    format!("{OCR_RUN_DIR_PREFIX}{pid}-{seq}-{timestamp_ms}")
}

/// Owns one run's scratch directory and removes it when the run ends.
///
/// `ocr_image_to_page` already deletes each preprocessed copy as soon as its page is
/// done, so a long PDF never holds more than one at a time — but that delete is
/// best-effort and does fail (on Windows, deleting a file another process still has
/// open raises a sharing violation). Dropping the whole directory is the backstop,
/// and being a `Drop` impl it covers the early `?` returns scattered through
/// `process_document_blocking` — a missing pdfium, a cancel between pages, an
/// unsupported extension — as well as a panic.
struct OcrWorkDir {
    path: PathBuf,
}

impl OcrWorkDir {
    fn create(root: &Path, name: &str) -> Result<Self, String> {
        let path = root.join(name);
        fs::create_dir_all(&path)
            .map_err(|error| format!("failed to create ocr work directory: {error}"))?;
        Ok(OcrWorkDir { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for OcrWorkDir {
    fn drop(&mut self) {
        // Best-effort: a file an AV scanner or a lingering tesseract still holds open
        // keeps the directory alive, and the startup sweep reclaims it later.
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Garbage-collect OCR scratch left behind when a run's cleanup never got to happen
/// (a crash, a kill, a locked file). Called once at startup.
///
/// Only ever touches entries *inside* `<cache>/ocr/`, never that directory or the
/// cache root — on Windows the cache root is `%LOCALAPPDATA%\<identifier>`, which
/// holds the live WebView2 profile (see `reset.rs`).
///
/// Also clears the flat `*_ocr.png` files written by versions before the per-run
/// directories existed; those were overwritten in place rather than accumulating, so
/// an upgrading user has at most a handful, but nothing else will ever remove them.
pub fn sweep_stale_ocr_work_dirs(cache_dir: &Path) {
    let root = cache_dir.join("ocr");
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let is_run_dir = name.starts_with(OCR_RUN_DIR_PREFIX);
        let is_legacy_file = name.ends_with("_ocr.png");
        if !is_run_dir && !is_legacy_file {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|modified| {
                modified
                    .elapsed()
                    .map(|age| age > OCR_RUN_RETENTION)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !stale {
            continue;
        }
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Produce a preprocessed copy of `source` for Tesseract.
/// Returns (preprocessed_path, scale_factor). Callers divide OCR bounding boxes by
/// scale_factor to map back to original-image coordinates.
///
/// Pipeline: grayscale ->  Lanczos upscale (if narrow side < threshold) -> save.
/// Tesseract binarizes internally, which handles thin antialiased screen fonts
/// better than a hard global threshold on native-resolution pixels.
///
/// The output name is only unique *within* `out_dir` — it is the source file's stem,
/// which on the image path is whatever the user named their file. Callers must pass a
/// scratch directory private to one run ([`OcrWorkDir`]); a shared one lets two runs
/// over the same filename overwrite and delete each other's copy.
fn preprocess_for_ocr(
    source: &Path,
    out_dir: &Path,
    allow_upscale: bool,
) -> Result<(PathBuf, f32), String> {
    let img =
        image::open(source).map_err(|e| format!("failed to open image for preprocessing: {e}"))?;

    let (w, h) = img.dimensions();
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("page");
    let scale: f32 = upscale_factor(w, h, allow_upscale);

    let gray: GrayImage = img.grayscale().to_luma8();

    let upscaled = if scale != 1.0 {
        DynamicImage::ImageLuma8(gray)
            .resize_exact(
                (w as f32 * scale) as u32,
                (h as f32 * scale) as u32,
                image::imageops::FilterType::Lanczos3,
            )
            .to_luma8()
    } else {
        gray
    };

    let out_path = out_dir.join(format!("{stem}_ocr.png"));
    DynamicImage::ImageLuma8(upscaled)
        .save(&out_path)
        .map_err(|e| format!("failed to save preprocessed image: {e}"))?;

    Ok((out_path, scale))
}

fn ocr_image_to_page(
    image_path: &Path,
    natural_width: i32,
    natural_height: i32,
    work_dir: &Path,
    allow_upscale: bool,
    engine: &catalog::OcrEngine,
) -> Result<DocumentPageResult, String> {
    let (ocr_path, scale) = preprocess_for_ocr(image_path, work_dir, allow_upscale)?;

    // The preprocessed copy is a throwaway OCR working file. Run OCR, then delete
    // it regardless of outcome so these copies never accumulate (they used to be
    // written into the persistent sessions/ folder, untracked, and pile up forever).
    let result = match engine {
        catalog::OcrEngine::Tesseract(spec) => run_tesseract(
            &ocr_path,
            image_path,
            natural_width,
            natural_height,
            scale,
            spec,
        ),
        catalog::OcrEngine::OarOcr(spec) => run_oar_ocr(
            &ocr_path,
            image_path,
            natural_width,
            natural_height,
            scale,
            spec,
        ),
    };

    let _ = fs::remove_file(&ocr_path);

    result
}

fn run_tesseract(
    ocr_path: &Path,
    image_path: &Path,
    natural_width: i32,
    natural_height: i32,
    scale: f32,
    spec: &catalog::TesseractSpec,
) -> Result<DocumentPageResult, String> {
    let args = rusty_tesseract::Args {
        lang: spec.lang.to_string(),
        psm: Some(spec.psm.into()),
        dpi: None, // let Tesseract estimate from image; the default 150 misrepresents upscaled content
        ..Default::default()
    };

    let tesseract_image = rusty_tesseract::tesseract::input::Image::from_path(ocr_path)
        .map_err(|error| format!("failed to load image for ocr: {error}"))?;

    let ocr_output =
        rusty_tesseract::tesseract::output_data::image_to_data(&tesseract_image, &args)
            .map_err(|error| format!("ocr failed: {error}"))?;

    let words = ocr_output
        .data
        .into_iter()
        .filter(|item| item.level == 5 && !item.text.trim().is_empty())
        .map(|item| OcrWord {
            // The frontend assigns ids once, on first load, and persists them.
            id: None,
            text: item.text,
            confidence: item.conf,
            box_coords: BoundingBox {
                left: map_coord(item.left, scale),
                top: map_coord(item.top, scale),
                width: map_coord(item.width, scale),
                height: map_coord(item.height, scale),
            },
        })
        .collect::<Vec<_>>();

    Ok(DocumentPageResult {
        image_path: image_path.to_string_lossy().into_owned(),
        natural_width,
        natural_height,
        words,
        text: ocr_output.output,
        error: None,
    })
}

/// oar-ocr instead of Tesseract (see `prototypes/OarOcr`). Rebuilt per call
/// rather than cached/shared across the document's pages — not optimized yet,
/// swappable-via-manifest correctness came first.
///
/// `det_model`/`rec_model`/`dict` are resolved through oar-ocr's own
/// `auto-download` (ModelScope, hash-verified by the crate) rather than the
/// paths `setup.rs` pins under `models/oar-ocr/` — that wiring is the
/// remaining step to make this fully match Tesseract's "everything pinned by
/// this app" story (see `setup.rs::get_oar_ocr_asset_specs`).
fn run_oar_ocr(
    ocr_path: &Path,
    image_path: &Path,
    natural_width: i32,
    natural_height: i32,
    scale: f32,
    spec: &catalog::OarOcrSpec,
) -> Result<DocumentPageResult, String> {
    let engine = OAROCRBuilder::new(spec.det_model, spec.rec_model, spec.dict)
        .return_word_box(spec.word_box)
        .build()
        .map_err(|error| format!("failed to build oar-ocr pipeline: {error}"))?;

    let rgb_image = image::open(ocr_path)
        .map_err(|error| format!("failed to load image for ocr: {error}"))?
        .to_rgb8();

    let mut results = engine
        .predict(vec![rgb_image])
        .map_err(|error| format!("ocr failed: {error}"))?;
    let page_result = results.pop().ok_or("oar-ocr returned no page result")?;

    let mut words = Vec::new();
    let mut full_text_lines = Vec::new();
    for region in &page_result.text_regions {
        let Some((text, confidence)) = region.text_with_confidence() else {
            continue;
        };
        full_text_lines.push(text.to_string());

        match &region.word_boxes {
            // oar-ocr's word_boxes is one box PER CHARACTER, not per word
            // (see prototypes/OarOcr/README.md) -- reconstruct real word
            // boxes by splitting on whitespace and unioning the runs.
            // Confidence has no per-word signal, so every word inherits
            // its parent line's score.
            Some(char_boxes) => {
                let split = split_into_words(text, char_boxes);
                if split.is_empty() {
                    words.push(oar_region_to_word(
                        text,
                        &region.bounding_box,
                        confidence,
                        scale,
                    ));
                } else {
                    for (word_text, word_box) in split {
                        words.push(oar_region_to_word(&word_text, &word_box, confidence, scale));
                    }
                }
            }
            None => words.push(oar_region_to_word(
                text,
                &region.bounding_box,
                confidence,
                scale,
            )),
        }
    }

    Ok(DocumentPageResult {
        image_path: image_path.to_string_lossy().into_owned(),
        natural_width,
        natural_height,
        words,
        text: full_text_lines.join("\n"),
        error: None,
    })
}

// ---- oar-ocr helpers (see prototypes/OarOcr) ----

/// oar-ocr's `word_boxes` is one box per CHARACTER of the recognized line, not
/// per word (see its `ctc_word_boxes`) -- split `text` on whitespace and union
/// the corresponding run of character boxes into real word boxes.
fn split_into_words(text: &str, char_boxes: &[OarBox]) -> Vec<(String, OarBox)> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() != char_boxes.len() {
        return Vec::new();
    }

    let mut words = Vec::new();
    let mut cur_text = String::new();
    let mut cur_boxes: Vec<&OarBox> = Vec::new();

    for (ch, b) in chars.iter().zip(char_boxes.iter()) {
        if ch.is_whitespace() {
            if !cur_text.is_empty() {
                words.push((std::mem::take(&mut cur_text), union_boxes(&cur_boxes)));
                cur_boxes.clear();
            }
        } else {
            cur_text.push(*ch);
            cur_boxes.push(b);
        }
    }
    if !cur_text.is_empty() {
        words.push((cur_text, union_boxes(&cur_boxes)));
    }
    words
}

fn union_boxes(boxes: &[&OarBox]) -> OarBox {
    let mut x_min = f32::INFINITY;
    let mut y_min = f32::INFINITY;
    let mut x_max = f32::NEG_INFINITY;
    let mut y_max = f32::NEG_INFINITY;
    for b in boxes {
        x_min = x_min.min(b.x_min());
        y_min = y_min.min(b.y_min());
        x_max = x_max.max(b.x_max());
        y_max = y_max.max(b.y_max());
    }
    OarBox::from_coords(x_min, y_min, x_max, y_max)
}

/// Maps an oar-ocr box (in preprocessed-image pixels) + line-level confidence
/// into an `OcrWord` in the original image's coordinate space, via the same
/// `map_coord` scale-division Tesseract's path uses.
fn oar_region_to_word(text: &str, region_box: &OarBox, confidence: f32, scale: f32) -> OcrWord {
    let left = region_box.x_min();
    let top = region_box.y_min();
    let width = region_box.x_max() - left;
    let height = region_box.y_max() - top;
    OcrWord {
        id: None,
        text: text.to_string(),
        confidence: confidence * 100.0, // oar-ocr is 0-1; OcrWord/Tesseract is 0-100
        box_coords: BoundingBox {
            left: map_coord(left.round() as i32, scale),
            top: map_coord(top.round() as i32, scale),
            width: map_coord(width.round() as i32, scale),
            height: map_coord(height.round() as i32, scale),
        },
    }
}

/// User-facing error returned when a job is aborted via `cancel_process_document`.
/// The frontend matches on this to show a neutral "cancelled" state instead of a
/// red failure.
pub const CANCELLED_MESSAGE: &str = "Document processing was cancelled.";

#[tauri::command]
pub async fn process_document(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, ProcessState>,
    session_id: String,
    file_path: String,
    preset_id: Option<String>,
) -> Result<ExtractionResult, String> {
    // All the heavy work below — pdfium rendering, image resizing, the Tesseract
    // subprocess — is synchronous and CPU/IO-bound. Running it directly in this async
    // command would block a Tokio worker for the whole job (minutes on a long PDF) and
    // starve other commands. Hand it to the blocking pool instead (design review H5).
    //
    // The cancel flag is shared via the Arc, so `cancel_process_document` (main thread)
    // and this worker poll the same atomic. pdfium objects are `!Send`, so the entire
    // body must live on one blocking thread — we can't move the document across threads
    // per page.
    let generation = Arc::clone(&state.generation);
    let app_handle = app_handle.clone();

    tokio::task::spawn_blocking(move || {
        process_document_blocking(app_handle, generation, session_id, file_path, preset_id)
    })
    .await
    .map_err(|error| format!("document processing task failed: {error}"))?
}

/// Synchronous body of [`process_document`], run on the blocking thread pool.
fn process_document_blocking(
    app_handle: tauri::AppHandle,
    generation: Arc<AtomicU64>,
    session_id: String,
    file_path: String,
    preset_id: Option<String>,
) -> Result<ExtractionResult, String> {
    // Snapshot the cancellation generation at entry. If `cancel_process_document`
    // bumps it while we're working, the per-page check below aborts this run.
    let start_generation = generation.load(Ordering::SeqCst);
    let is_cancelled = || generation.load(Ordering::SeqCst) != start_generation;

    let source_path = Path::new(&file_path);

    if !source_path.exists() {
        return Err(format!("Input file does not exist: {file_path}"));
    }

    let file_size = fs::metadata(source_path)
        .map_err(|e| format!("Failed to read file metadata: {e}"))?
        .len();

    if file_size > MAX_FILE_SIZE_BYTES {
        return Err(format!(
            "File exceeds the 500 MB size limit ({} bytes)",
            file_size
        ));
    }

    let extension = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Tesseract's PATH / TESSDATA_PREFIX is configured once at startup
    // (`configure_tesseract_env`, called from the Tauri setup hook on the main
    // thread). We deliberately do NOT touch the process environment here: mutating
    // `std::env` from this blocking worker would race with env reads on other
    // threads (a data race / UB under the Rust 2024 model). The startup hook points
    // the env at the canonical AppData tesseract location whether or not it exists
    // yet, so a mid-session wizard install is picked up without a restart.
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;

    // Which classical OCR engine grounds this run's words — the preset the caller
    // named, or (mirroring `run_extraction_pipeline`) whatever this install was set
    // up for. A preset with no `GroundOcr` step (none exist today, but `GroundModel`
    // makes it possible in principle) can't be run through this word-grounding path.
    let preset = match preset_id {
        Some(id) => catalog::preset(&id).ok_or_else(|| format!("unknown preset `{id}`"))?,
        None => crate::setup::read_persisted_preset(&data_dir),
    };
    let engine = preset.ocr_engine().ok_or_else(|| {
        format!(
            "preset `{}` has no classical OCR step for process_document to run",
            preset.id
        )
    })?;

    // Tesseract's PATH / TESSDATA_PREFIX is configured once at startup regardless of
    // which preset is selected, but its language data is only demanded when the
    // resolved engine actually needs it — a preset grounded on oar-ocr never
    // downloads Tesseract at all (see `setup.rs::required_assets`), so requiring its
    // traineddata unconditionally would block a perfectly complete install.
    if matches!(engine, catalog::OcrEngine::Tesseract(_)) {
        let eng_traineddata = data_dir
            .join("tesseract")
            .join("tessdata")
            .join("eng.traineddata");
        if !eng_traineddata.exists() {
            return Err(format!(
                "Tesseract English language data not found at {}. Re-run setup to reinstall Tesseract.",
                eng_traineddata.display()
            ));
        }

        // Ensure the `tsv` output config exists even if the Tesseract package shipped
        // without its configs/ dir — otherwise OCR silently returns plain text.
        ensure_tesseract_tsv_config(&data_dir);
    }

    let session_dir = app_handle
        .path()
        .resolve("sessions", tauri::path::BaseDirectory::AppData)
        .map_err(|error| format!("failed to resolve output directory: {error}"))?;

    std::fs::create_dir_all(&session_dir)
        .map_err(|error| format!("failed to create output directory: {error}"))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    // Scratch space for preprocessed OCR copies. These are transient working files
    // (deleted right after each page is OCR'd), so they live in the app cache dir
    // rather than the persistent sessions/ folder.
    //
    // Private to this run: nothing serializes `process_document`, so a second run over
    // the same source file can be in flight at the same time, and the copies are named
    // after that file (see `ocr_run_dir_name`). The guard removes the directory on
    // every exit path.
    let ocr_work_root = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to resolve cache directory: {error}"))?
        .join("ocr");
    let ocr_work = OcrWorkDir::create(
        &ocr_work_root,
        &ocr_run_dir_name(
            std::process::id(),
            OCR_RUN_SEQ.fetch_add(1, Ordering::Relaxed),
            timestamp,
        ),
    )?;
    let ocr_work_dir = ocr_work.path();

    let mut pages: Vec<DocumentPageResult> = Vec::new();

    let input_kind = classify_extension(&extension);
    if input_kind == InputKind::Pdf {
        // Load the PDFium library the wizard downloaded into AppData rather than a
        // system copy — neither Windows nor macOS ships one. bind_to_library takes
        // the full path to the shared library, so it resolves regardless of the
        // process's library search path.
        let pdfium_lib = data_dir.join("binaries").join(pdfium_lib_name());
        if !pdfium_lib.exists() {
            return Err(format!(
                "PDFium library not found at {}. Re-run setup to reinstall it.",
                pdfium_lib.display()
            ));
        }
        let pdfium = Pdfium::new(Pdfium::bind_to_library(&pdfium_lib).map_err(|error| {
            format!(
                "failed to bind to pdfium at {}: {error}",
                pdfium_lib.display()
            )
        })?);

        let document = pdfium
            .load_pdf_from_file(source_path, None)
            .map_err(|error| format!("failed to open pdf: {error}"))?;

        let render_config = PdfRenderConfig::new()
            .set_target_width(2000)
            .use_print_quality(true);

        // Stay in pdfium's own index type rather than round-tripping through `usize`:
        // `get` takes a `PdfPageIndex`, so a `usize` loop counter has to be cast back
        // on every iteration, and a cast at that spot reads like *we* are the ones
        // narrowing the count (we aren't — see `validate_pdf_page_count`).
        let page_count = document.pages().len();
        validate_pdf_page_count(page_count)?;
        let total_pages = usize::from(page_count);

        for index in 0..page_count {
            // Stop promptly between pages if the user cancelled. Checked before
            // rendering the next page so a cancel on a long PDF takes effect within
            // one page rather than running to completion.
            if is_cancelled() {
                return Err(CANCELLED_MESSAGE.to_string());
            }

            // The 1-based number shown to the user and written into file names.
            // Widened first so the `+ 1` can't overflow the index type.
            let page_number = usize::from(index) + 1;

            // Render + OCR a single page. Any failure here is captured as a per-page
            // error below rather than aborting the document, so one corrupt page in a
            // 100-page PDF doesn't discard the 99 that processed fine.
            let render_and_ocr = || -> Result<DocumentPageResult, String> {
                let page = document
                    .pages()
                    .get(index)
                    .map_err(|error| format!("failed to read page {page_number}: {error}"))?;

                let bitmap = page
                    .render_with_config(&render_config)
                    .map_err(|error| format!("failed to render page {page_number}: {error}"))?;

                let natural_width = bitmap.width();
                let natural_height = bitmap.height();

                let generated_path =
                    session_dir.join(format!("{session_id}_page_{page_number}_{timestamp}.png"));
                bitmap
                    .as_image()
                    .save(&generated_path)
                    .map_err(|error| format!("failed to save page {page_number}: {error}"))?;

                ocr_image_to_page(
                    &generated_path,
                    natural_width,
                    natural_height,
                    ocr_work_dir,
                    false, // already high-res from pdfium; do not upscale
                    engine,
                )
            };

            match render_and_ocr() {
                Ok(page) => pages.push(page),
                Err(message) => pages.push(DocumentPageResult {
                    image_path: String::new(),
                    natural_width: 0,
                    natural_height: 0,
                    words: Vec::new(),
                    text: String::new(),
                    error: Some(message),
                }),
            }

            // Let the UI advance its progress indicator as each page completes.
            let _ = app_handle.emit(
                "process:progress",
                ProcessProgress {
                    session_id: session_id.clone(),
                    current_page: page_number,
                    total_pages,
                },
            );
        }
    } else if input_kind == InputKind::Image {
        // A single image is one uninterruptible OCR call, so honor a cancel that
        // arrives before it begins (mid-call cancellation isn't possible — the
        // frontend discards the result if one still arrives after the user cancels).
        if is_cancelled() {
            return Err(CANCELLED_MESSAGE.to_string());
        }

        let (natural_width, natural_height) = image::image_dimensions(source_path)
            .map(|(w, h)| (w as i32, h as i32))
            .unwrap_or((0, 0));

        pages.push(ocr_image_to_page(
            source_path,
            natural_width,
            natural_height,
            ocr_work_dir,
            true, // arbitrary resolution; upscale if small
            engine,
        )?);
    } else {
        return Err(format!("Unsupported file format: .{}", extension));
    }

    Ok(ExtractionResult { session_id, pages })
}

/// Prepend the bundled Tesseract dir to PATH and point TESSDATA_PREFIX at its
/// `tessdata` folder so OCR (which invokes a bare `tesseract` binary) resolves
/// the right executable and language data.
///
/// Call this exactly once, at startup, from the main thread (the Tauri setup
/// hook) — never from a worker thread. Mutating `std::env` while other threads
/// read it is a data race (UB under the Rust 2024 model), and OCR runs on the
/// blocking pool. Doing it once up front, before any command can fire, sidesteps
/// that entirely.
///
/// The target paths are set whether or not the `tesseract` dir exists yet: it is
/// the deterministic AppData location the first-run wizard installs into, so a
/// mid-session install lands exactly where the env already points and OCR works
/// without an app restart (the webview reload after setup does not restart the
/// Rust process).
///
/// Idempotent — the PATH prepend is skipped if the dir is already present.
///
/// Note: this Tesseract 5.x build requires TESSDATA_PREFIX to point *directly at*
/// the tessdata folder — pointing it at the parent dir makes tesseract exit
/// non-zero with no output.
pub fn configure_tesseract_env(data_dir: &Path) {
    let dir = data_dir.join("tesseract");
    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    let dir_str = dir.display().to_string();
    let current = std::env::var("PATH").unwrap_or_default();
    if !current.split(sep).any(|p| p == dir_str) {
        std::env::set_var("PATH", format!("{dir_str}{sep}{current}"));
    }
    std::env::set_var(
        "TESSDATA_PREFIX",
        dir.join("tessdata").display().to_string(),
    );
}

/// Guarantee the `tsv` output config exists.
///
/// rusty-tesseract requests TSV by passing the *config file name* `tsv` to the
/// tesseract CLI; the engine resolves it at `<tessdata>/configs/tsv` (a one-line
/// file: `tessedit_create_tsv 1`). Some Tesseract packages omit the `configs/`
/// directory entirely — then tesseract logs "read_params_file: Can't open tsv"
/// and silently falls back to plain-text output, which fails our TSV parser with
/// "Could not parse invalid line". We depend on exactly this one config, so write
/// it ourselves when missing rather than trusting every package to include it.
/// Idempotent; safe to call before each OCR run.
fn ensure_tesseract_tsv_config(data_dir: &Path) {
    let configs_dir = data_dir.join("tesseract").join("tessdata").join("configs");
    let tsv = configs_dir.join("tsv");
    if tsv.exists() {
        return;
    }
    if fs::create_dir_all(&configs_dir).is_ok() {
        let _ = fs::write(&tsv, "tessedit_create_tsv 1\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upscale_factor_doubles_small_allowed_images_only() {
        // narrow side < 1500 and upscaling allowed -> 2.0
        assert_eq!(upscale_factor(1000, 800, true), 2.0);
        // narrow side >= threshold -> 1.0 even when allowed
        assert_eq!(upscale_factor(2000, 1600, true), 1.0);
        // exactly at the threshold is not "below" -> 1.0
        assert_eq!(upscale_factor(1500, 1500, true), 1.0);
        // upscaling disallowed (pdf path) -> always 1.0
        assert_eq!(upscale_factor(500, 500, false), 1.0);
    }

    #[test]
    fn map_coord_divides_by_scale_and_rounds() {
        // At scale 1.0 coordinates pass through unchanged.
        assert_eq!(map_coord(123, 1.0), 123);
        // At scale 2.0 an upscaled coordinate maps back to original space.
        assert_eq!(map_coord(200, 2.0), 100);
        // Rounding to nearest integer.
        assert_eq!(map_coord(101, 2.0), 51); // 50.5 -> 51 (round half up)
    }

    #[test]
    fn classify_extension_dispatch() {
        assert_eq!(classify_extension("pdf"), InputKind::Pdf);
        assert_eq!(classify_extension("png"), InputKind::Image);
        assert_eq!(classify_extension("jpg"), InputKind::Image);
        assert_eq!(classify_extension("jpeg"), InputKind::Image);
        assert_eq!(classify_extension("gif"), InputKind::Unsupported);
        assert_eq!(classify_extension(""), InputKind::Unsupported);
    }

    #[test]
    fn max_file_size_is_500_mb() {
        assert_eq!(MAX_FILE_SIZE_BYTES, 500 * 1024 * 1024);
    }

    #[test]
    fn ensure_tesseract_tsv_config_writes_the_config() {
        let dir = tempfile::tempdir().unwrap();
        let tsv = dir
            .path()
            .join("tesseract")
            .join("tessdata")
            .join("configs")
            .join("tsv");
        assert!(!tsv.exists());
        ensure_tesseract_tsv_config(dir.path());
        assert!(tsv.exists());
        assert_eq!(fs::read_to_string(&tsv).unwrap(), "tessedit_create_tsv 1\n");
        // Idempotent: a second call doesn't error or change it.
        ensure_tesseract_tsv_config(dir.path());
        assert!(tsv.exists());
    }

    #[test]
    fn validate_pdf_page_count_rejects_both_ends() {
        assert!(validate_pdf_page_count(1).is_ok());
        assert!(
            validate_pdf_page_count(MAX_PDF_PAGES).is_ok(),
            "the cap itself is allowed"
        );

        // Zero must not reach the frontend: 0 rows + a page_count-0 marker reads back
        // as a *complete* cache, stranding the session on an empty document.
        let empty = validate_pdf_page_count(0).unwrap_err();
        assert!(empty.contains("no pages"), "got: {empty}");

        let too_many = validate_pdf_page_count(MAX_PDF_PAGES + 1).unwrap_err();
        assert!(
            too_many.contains("2001") && too_many.contains("2000"),
            "the message must name both the actual count and the limit; got: {too_many}"
        );
        assert!(
            too_many.contains("Split"),
            "the message must say what to do about it; got: {too_many}"
        );
    }

    #[test]
    fn ocr_run_dir_name_is_unique_per_run_instance_and_launch() {
        let a = ocr_run_dir_name(1234, 0, 1_700_000_000_000);
        assert_eq!(a, "run-1234-0-1700000000000");
        assert!(a.starts_with(OCR_RUN_DIR_PREFIX), "the sweep matches on it");

        // Same process, next run.
        assert_ne!(a, ocr_run_dir_name(1234, 1, 1_700_000_000_000));
        // Concurrent second app instance starting its first run in the same ms.
        assert_ne!(a, ocr_run_dir_name(5678, 0, 1_700_000_000_000));
        // Same pid reused after a restart, counter back at zero.
        assert_ne!(a, ocr_run_dir_name(1234, 0, 1_700_000_009_999));
    }

    #[test]
    fn ocr_work_dir_removes_itself_and_its_contents_on_drop() {
        let root = tempfile::tempdir().unwrap();
        let path;
        {
            let work = OcrWorkDir::create(root.path(), "run-1-0-1").unwrap();
            path = work.path().to_path_buf();
            assert!(path.is_dir());
            // A page whose own delete failed (a Windows sharing violation, say) must
            // still go with the directory.
            fs::write(path.join("scan_ocr.png"), b"leftover").unwrap();
        }
        assert!(!path.exists(), "the scratch dir must not outlive the run");
        assert!(root.path().is_dir(), "the shared ocr/ root must survive");
    }

    #[test]
    fn two_runs_over_the_same_filename_get_separate_scratch_dirs() {
        // The regression this guards: both runs preprocess a file whose stem is the
        // user's, so before per-run dirs they wrote — and deleted — one shared path.
        let root = tempfile::tempdir().unwrap();
        let a = OcrWorkDir::create(root.path(), &ocr_run_dir_name(1, 0, 1)).unwrap();
        let b = OcrWorkDir::create(root.path(), &ocr_run_dir_name(1, 1, 1)).unwrap();

        let a_copy = a.path().join("scan_ocr.png");
        let b_copy = b.path().join("scan_ocr.png");
        fs::write(&a_copy, b"a").unwrap();
        fs::write(&b_copy, b"b").unwrap();
        assert_ne!(a_copy, b_copy);

        // Finishing the first run leaves the second run's working file untouched.
        drop(a);
        assert!(!a_copy.exists());
        assert_eq!(fs::read(&b_copy).unwrap(), b"b");
    }

    #[test]
    fn sweep_stale_ocr_work_dirs_keeps_live_runs_and_reclaims_crashed_ones() {
        let cache = tempfile::tempdir().unwrap();
        let ocr = cache.path().join("ocr");
        fs::create_dir_all(&ocr).unwrap();

        let live = ocr.join("run-1-0-1");
        let crashed = ocr.join("run-2-0-2");
        let legacy = ocr.join("scan_ocr.png");
        let unrelated = ocr.join("keep.txt");
        fs::create_dir_all(&live).unwrap();
        fs::create_dir_all(&crashed).unwrap();
        fs::write(crashed.join("page_ocr.png"), b"debris").unwrap();
        fs::write(&legacy, b"pre-upgrade").unwrap();
        fs::write(&unrelated, b"not ours").unwrap();

        let two_days_ago = SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);
        let backdated = filetime::FileTime::from_system_time(two_days_ago);
        filetime::set_file_mtime(&crashed, backdated).unwrap();
        filetime::set_file_mtime(&legacy, backdated).unwrap();

        sweep_stale_ocr_work_dirs(cache.path());

        assert!(
            live.is_dir(),
            "a recent run dir may belong to a job still in flight in another instance"
        );
        assert!(!crashed.exists(), "an abandoned run dir must be reclaimed");
        assert!(
            !legacy.exists(),
            "pre-upgrade flat copies must be reclaimed"
        );
        assert!(unrelated.exists(), "unrecognized entries must be untouched");
        assert!(ocr.is_dir(), "the ocr/ root itself must never be removed");
    }
}
