//! The bundled pipeline catalog: which models exist, what each is allowed to do,
//! and which ordered sequences of steps ("presets") the app can run.
//!
//! This is deliberately **typed Rust constants, not an external data file**. The
//! same reasoning that governs the asset manifest applies here (design.md §7.1):
//! model URLs, digests, launch flags and prompts are auditable as a unit, and a
//! user-editable manifest would both break the Microsoft Store 10.2.2 claim that
//! every download is pinned and verified (release.md §6.4) and let arbitrary flags
//! reach the `llama-server` argv, against the hardening rationale in `llama.rs`.
//!
//! # Why the prompts live here
//!
//! A prompt is part of a model's contract, not a UI string. Surya's is copied
//! verbatim from its training source and must not be paraphrased; Qwen's encodes
//! the TSV-not-CSV decision (design.md §4). Keeping them beside the model that
//! requires them is what stops the two drifting apart.
//!
use serde::Serialize;

use crate::paths::{MMPROJ_FILENAME, MODEL_FILENAME};

// ---------------------------------------------------------------------------
// Capability and role vocabulary
// ---------------------------------------------------------------------------

/// What a model is permitted to do. A step may only name a model whose roles
/// include the role that step requires — this is what "certain models are only
/// allowed for certain stages" means concretely, and `validate` enforces it.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    /// Produces source text with locations — the provenance spine.
    Ground,
    /// Produces the table from the page.
    Structure,
    /// Refines or corrects a table an upstream step already produced.
    Verify,
    /// Conversational use over an existing extraction. Reserved: no step kind
    /// consumes this yet, but it is part of the vocabulary so chat prompts and
    /// chat-capable models land in this same audited place rather than arriving
    /// as a parallel system later.
    Chat,
}

/// The granularity of the boxes a grounding source can supply, which decides how
/// precisely a cell can be traced back to the page.
///
/// Ordering matters and is not alphabetical: `Cell` is the best outcome, `None`
/// the worst. See `is_usable_for_grounding`.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Grounding {
    /// Supplies no locations at all.
    None,
    /// Region-level boxes only. An honest fallback, but a poor one: in the P0
    /// spike Surya's OCR mode returned an entire transcript as *one* block, so a
    /// preset should never rely on this tier when a better one is available.
    Block,
    /// Per-word text and boxes (Tesseract).
    Word,
    /// Row and column bands the model reports directly, which intersect into cell
    /// rectangles. Verified against Surya's `table` mode: 13×6 well-formed bands
    /// on the sample transcript, matching its row count exactly.
    Cell,
}

impl Grounding {
    pub fn is_usable_for_grounding(self) -> bool {
        !matches!(self, Grounding::None)
    }
}

/// The shape of a model's output, which decides which parser consumes it.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    /// Tab-separated rows, first row the header. Tabs never occur inside OCR'd
    /// cell content, so no escaping is needed (design.md §4).
    Tsv,
    /// Surya's `<div data-label data-bbox>` blocks; tables ride along as `<table>`.
    SuryaHtml,
    /// Surya's `table` mode: a JSON list of `{label: "Row"|"Col", bbox}` bands.
    SuryaTableJson,
}

/// Whether a step's model may stay loaded alongside another.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Residency {
    /// Evict any other model first. The safe default on constrained machines.
    Exclusive,
    /// May coexist, subject to a runtime free-memory check.
    Shared,
}

/// How many layers to offload to the GPU.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GpuLayers {
    /// Offload everything on a GPU backend, nothing on CPU. Mirrors the existing
    /// `999`/`0` branch in `llama.rs`.
    AllWhenGpu,
    /// A fixed count regardless of backend.
    Fixed(u32),
}

/// Which artifact of a model a file is.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileRole {
    Weights,
    Mmproj,
    ChatTemplate,
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PromptId {
    /// Qwen, image + spatial OCR text -> TSV. Today's Stage 1 prompt.
    QwenTsvExtract,
    /// The same task with no image attached, for a model whose vision support is
    /// unknown. Not a variant of the above by accident: telling a model to consult an
    /// attached image that isn't there is worse than not mentioning one.
    TsvExtractTextOnly,
    /// Qwen's system turn for the extraction path.
    QwenExtractSystem,
    /// Surya full-page OCR to HTML blocks. Training-time contract, verbatim.
    SuryaOcrHtml,
    /// Surya table row/column bands as JSON. Training-time contract, verbatim.
    SuryaTableBands,
}

/// The user-turn instruction block Stage 1 sends, byte-identical to the array
/// joined in the frontend today.
///
/// **The trailing `OCR text:\n` is load-bearing**: the spatially-arranged OCR text
/// is appended directly to this string with no separator, so changing the ending
/// changes the prompt the model has been tuned against. A unit test pins it.
const QWEN_TSV_EXTRACT: &str = "Return only TSV (tab-separated values).\n\
First row must be the column headers.\n\
No reasoning, no explanation, no code fences, no markdown.\n\
Separate each column with a tab character. Do not use commas as delimiters.\n\
If two adjacent values belong to the same visual column (e.g. a department code and a course number), output them as one field joined by a space.\n\
Use the attached image as the primary reference and the OCR text below as a guide.\n\
\n\
OCR text:\n";

/// The text-only variant. Identical in every instruction that does not concern the
/// image, so the two produce the same shape of output; the difference is that the OCR
/// text is described as the *only* source rather than as a guide to a picture.
const TSV_EXTRACT_TEXT_ONLY: &str = "Return only TSV (tab-separated values).\n\
First row must be the column headers.\n\
No reasoning, no explanation, no code fences, no markdown.\n\
Separate each column with a tab character. Do not use commas as delimiters.\n\
If two adjacent values belong to the same visual column (e.g. a department code and a course number), output them as one field joined by a space.\n\
The OCR text below preserves the page's layout: the spacing between values reflects the columns on the page.\n\
\n\
OCR text:\n";

const QWEN_EXTRACT_SYSTEM: &str = "You are a structured data extractor. \
Begin your response with the very first line of the requested format — no introduction, \
no analysis, no reasoning, no explanation before the data. \
Output only the data itself.";

// Verbatim from the Surya source via `prototypes/Surya`. Do not paraphrase: these
// are training-time contracts, and the bands the second one returns are what lets
// provenance take the grid from the model instead of inferring it.
const SURYA_OCR_HTML: &str = "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000).";
const SURYA_TABLE_BANDS: &str = "Output the table rows then columns as JSON. Each entry is a dict with \"label\" (\"Row\" or \"Col\") and \"bbox\" (x0 y0 x1 y1, normalized 0-1000).";

/// Exhaustive by construction — adding a `PromptId` without text fails to compile.
pub fn prompt_text(id: PromptId) -> &'static str {
    match id {
        PromptId::QwenTsvExtract => QWEN_TSV_EXTRACT,
        PromptId::TsvExtractTextOnly => TSV_EXTRACT_TEXT_ONLY,
        PromptId::QwenExtractSystem => QWEN_EXTRACT_SYSTEM,
        PromptId::SuryaOcrHtml => SURYA_OCR_HTML,
        PromptId::SuryaTableBands => SURYA_TABLE_BANDS,
    }
}

// ---------------------------------------------------------------------------
// Model specs
// ---------------------------------------------------------------------------

/// One file a model needs on disk.
#[derive(Serialize, Debug, Clone, Copy)]
pub struct ModelFile {
    pub role: FileRole,
    /// Asset id in the setup manifest that delivers this file.
    pub asset_id: &'static str,
    /// Path under the AppData `models/` directory.
    ///
    /// Qwen deliberately keeps its historical **flat** filename so existing
    /// installs need no filesystem migration; models added later nest under
    /// `<model_id>/` to keep multi-file bundles tidy.
    pub relative_path: &'static str,
}

/// How to launch `llama-server` for this model.
#[derive(Serialize, Debug, Clone, Copy)]
pub struct LaunchSpec {
    pub ctx: u32,
    /// `--image-min-tokens`, when the model's projector needs a floor.
    pub image_min_tokens: Option<u32>,
    pub parallel: u32,
    pub gpu_layers: GpuLayers,
    /// `--jinja`, to apply the model's embedded chat template.
    pub jinja: bool,
    /// `--alias`, when the model expects a specific served name.
    pub alias: Option<&'static str>,
}

/// How to shape the chat-completions request for this model.
#[derive(Serialize, Debug, Clone, Copy)]
pub struct RequestSpec {
    pub system_prompt: Option<PromptId>,
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: Option<u32>,
    pub presence_penalty: Option<f32>,
    pub stop: &'static [&'static str],
    /// `chat_template_kwargs.enable_thinking`. Qwen-specific; `None` omits the key.
    pub enable_thinking: Option<bool>,
    pub logprobs: bool,
    pub top_logprobs: u32,
}

#[derive(Serialize, Debug, Clone, Copy)]
pub struct Capabilities {
    pub vision: bool,
    /// Whether the server returns `choices[].logprobs.content[]` for this model.
    /// Confirmed for both Qwen and Surya by the `logprobs-test.mjs` spike.
    pub logprobs: bool,
    pub grounding: Grounding,
    pub output_format: OutputFormat,
}

/// Rough memory cost, used to recommend a preset and to decide whether two models
/// may be resident at once.
#[derive(Serialize, Debug, Clone, Copy)]
pub struct Footprint {
    pub weights_mb: u32,
    pub min_ram_mb: u32,
    pub min_vram_mb: Option<u32>,
}

#[derive(Serialize, Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub family: &'static str,
    pub files: &'static [ModelFile],
    pub launch: LaunchSpec,
    pub request: RequestSpec,
    pub caps: Capabilities,
    pub roles: &'static [ModelRole],
    pub footprint: Footprint,
    /// True when the *user* provides this model's files rather than the installer.
    ///
    /// Such a model is never downloaded, never pinned, and never recommended, and its
    /// `files` list is empty because the paths live in user config instead. The flag
    /// exists so those exemptions are a property of the model rather than a string
    /// comparison against a magic id scattered through `setup.rs` and the validator.
    pub user_supplied: bool,
}

impl ModelSpec {
    pub fn allows(&self, role: ModelRole) -> bool {
        self.roles.contains(&role)
    }

    pub fn file(&self, role: FileRole) -> Option<&'static ModelFile> {
        self.files.iter().find(|f| f.role == role)
    }
}

// ---------------------------------------------------------------------------
// Steps and presets
// ---------------------------------------------------------------------------

/// Tesseract's settings. Values mirror `ocr.rs`; `psm 6` (single uniform block)
/// and an unset DPI are the outcome of the preprocessing post-mortem in
/// `issues.md` § OCR/Preprocessing — do not "tidy" them without evidence.
#[derive(Serialize, Debug, Clone, Copy)]
pub struct TesseractSpec {
    pub psm: u8,
    pub lang: &'static str,
}

#[derive(Serialize, Debug, Clone, Copy)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    /// Rasterize the page. PDFs render at `target_width`; images are used as-is.
    Render { target_width: u32 },
    /// Ground on Tesseract: per-word text and pixel boxes.
    GroundTesseract { tesseract: TesseractSpec },
    /// Ground on a model that reports its own locations.
    GroundModel {
        model_id: &'static str,
        prompt: PromptId,
        residency: Residency,
    },
    /// Ask a model for the table's row and column **bands** — geometry only, no text.
    ///
    /// This is not a third way to ground a page; it is a separate axis, and keeping it
    /// separate is what the P0 spike argues for. Surya's bands were exact (13 × 6, a
    /// perfect column tiling) while its own HTML was internally inconsistent about the
    /// same table — it collapsed two columns under one header and dropped a value. So
    /// the useful pairing is not "Surya instead of Tesseract" but **Tesseract's words
    /// with Surya's grid**: each source used for the thing it is actually good at.
    ///
    /// The consequence for provenance is direct. Box precision stays at word level
    /// (better than cell), while `detectColumnSeparators` and the gap-based line split
    /// — the inference behind every Provenance/Matching post-mortem in `issues.md` —
    /// are replaced by ground truth.
    GroundGrid {
        model_id: &'static str,
        prompt: PromptId,
        residency: Residency,
    },
    /// Produce the table.
    Structure {
        model_id: &'static str,
        prompt: PromptId,
        residency: Residency,
    },
    /// Refine a table an upstream step produced.
    Verify {
        model_id: &'static str,
        prompt: PromptId,
        residency: Residency,
    },
}

impl Step {
    /// The role a model must hold to fill this step, or `None` for steps that
    /// don't involve a model.
    pub fn required_role(&self) -> Option<ModelRole> {
        match self {
            Step::Render { .. } | Step::GroundTesseract { .. } => None,
            Step::GroundModel { .. } | Step::GroundGrid { .. } => Some(ModelRole::Ground),
            Step::Structure { .. } => Some(ModelRole::Structure),
            Step::Verify { .. } => Some(ModelRole::Verify),
        }
    }

    pub fn model_id(&self) -> Option<&'static str> {
        match self {
            Step::Render { .. } | Step::GroundTesseract { .. } => None,
            Step::GroundModel { model_id, .. }
            | Step::GroundGrid { model_id, .. }
            | Step::Structure { model_id, .. }
            | Step::Verify { model_id, .. } => Some(model_id),
        }
    }

    /// Whether this step produces the located *text* provenance matches against.
    ///
    /// Exactly one step per preset must, which is why `GroundGrid` is excluded: it
    /// contributes geometry to whatever already supplied the items, so counting it
    /// here would make a words-plus-grid preset look like it grounds twice.
    pub fn supplies_items(&self) -> bool {
        matches!(
            self,
            Step::GroundTesseract { .. } | Step::GroundModel { .. }
        )
    }

    /// Whether this step produces row/column bands.
    pub fn supplies_grid(&self) -> bool {
        matches!(self, Step::GroundGrid { .. })
    }
}

#[derive(Serialize, Debug, Clone, Copy)]
pub struct Requirements {
    pub min_ram_mb: u32,
    pub min_vram_mb: Option<u32>,
}

#[derive(Serialize, Debug, Clone, Copy)]
pub struct PipelinePreset {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Bumped when a preset's behaviour changes, so a cached run can be
    /// recognised as stale rather than silently mixed with new output.
    pub version: u32,
    pub requires: Requirements,
    pub steps: &'static [Step],
}

impl PipelinePreset {
    /// How precisely a cell can be traced back to the page.
    ///
    /// Derived from the step that supplies the *items* rather than stored as a field,
    /// so the two cannot drift apart. A `GroundGrid` step deliberately does not affect
    /// this: bands say where the table's rows and columns are, not where a value's
    /// glyphs are, so a preset pairing Tesseract's words with a model's grid still
    /// highlights at word precision — which is finer than `Cell`, not coarser.
    pub fn grounding(&self) -> Grounding {
        for step in self.steps {
            match step {
                Step::GroundTesseract { .. } => return Grounding::Word,
                Step::GroundModel { model_id, .. } => {
                    return model(model_id).map_or(Grounding::None, |m| m.caps.grounding)
                }
                _ => {}
            }
        }
        Grounding::None
    }

    /// Whether a model reports this preset's table grid instead of it being inferred.
    pub fn declares_grid(&self) -> bool {
        self.steps.iter().any(Step::supplies_grid)
    }

    /// Every distinct model this preset needs installed.
    pub fn model_ids(&self) -> Vec<&'static str> {
        let mut ids = Vec::new();
        for step in self.steps {
            if let Some(id) = step.model_id() {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        ids
    }

    pub fn uses_tesseract(&self) -> bool {
        self.steps
            .iter()
            .any(|s| matches!(s, Step::GroundTesseract { .. }))
    }
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/// Page render width for PDFs, mirroring `ocr.rs`.
const RENDER_TARGET_WIDTH: u32 = 2000;

pub const QWEN_3_5_4B: ModelSpec = ModelSpec {
    id: "qwen3.5-4b",
    label: "Qwen3.5 4B (vision)",
    family: "qwen",
    files: &[
        ModelFile {
            role: FileRole::Weights,
            asset_id: "model_gguf",
            relative_path: MODEL_FILENAME,
        },
        ModelFile {
            role: FileRole::Mmproj,
            asset_id: "mmproj_gguf",
            relative_path: MMPROJ_FILENAME,
        },
    ],
    // Mirrors the argv `llama.rs` builds today.
    launch: LaunchSpec {
        ctx: 8192,
        image_min_tokens: Some(1024),
        parallel: 1,
        gpu_layers: GpuLayers::AllWhenGpu,
        jinja: false,
        alias: None,
    },
    // Mirrors `extractTableFromImage`'s request body today: greedy sampling, no
    // presence penalty, logprobs on for the confidence heatmap.
    request: RequestSpec {
        system_prompt: Some(PromptId::QwenExtractSystem),
        temperature: 0.0,
        top_p: 1.0,
        top_k: Some(1),
        presence_penalty: Some(0.0),
        stop: &["<|im_start|>", "<|im_end|>"],
        enable_thinking: Some(false),
        logprobs: true,
        top_logprobs: 0,
    },
    caps: Capabilities {
        vision: true,
        logprobs: true,
        // Qwen reads the page but reports no locations of its own; provenance for
        // a Qwen-structured table comes from whatever grounded the page.
        grounding: Grounding::None,
        output_format: OutputFormat::Tsv,
    },
    roles: &[ModelRole::Structure, ModelRole::Verify, ModelRole::Chat],
    footprint: Footprint {
        weights_mb: 3_255, // 2.74 GB weights + 672 MB projector
        min_ram_mb: 8_192,
        min_vram_mb: None,
    },
    user_supplied: false,
};

/// Surya-OCR-2, used **only** for the row/column bands its `table` mode reports.
///
/// Its `ocr` mode also returns text, and that text is deliberately not used yet: in
/// the P0 spike the same page came back with exact geometry and an internally
/// inconsistent `<table>` (two columns collapsed under one header, a value dropped).
/// `roles` therefore lists `Ground` alone, and `output_format` is the band JSON —
/// a preset asking this model to structure a table is rejected by `validate_catalog`.
///
/// Sampling mirrors the prototype's serve mode: greedy, so the same page yields the
/// same bands twice. Logprobs stay on because the grounder's own token confidences are
/// what a future text-grounding tier would score cells with (`pipeline/surya.rs`
/// already records the offsets for it).
pub const SURYA_OCR_2: ModelSpec = ModelSpec {
    id: "surya-ocr-2",
    label: "Surya OCR 2 (layout)",
    family: "surya",
    files: &[
        ModelFile {
            role: FileRole::Weights,
            asset_id: "surya_ocr2_gguf",
            relative_path: "surya-ocr-2/surya-ocr-2-Q8_0.gguf",
        },
        ModelFile {
            role: FileRole::Mmproj,
            asset_id: "surya_ocr2_mmproj_gguf",
            relative_path: "surya-ocr-2/mmproj-surya-ocr-2-F16.gguf",
        },
    ],
    launch: LaunchSpec {
        // Bands are a couple of hundred tokens (192 for a 13-row transcript in the P0
        // run), so a large window buys nothing and costs KV cache on a machine that is
        // about to hold a second model as well.
        ctx: 4096,
        image_min_tokens: None,
        parallel: 1,
        gpu_layers: GpuLayers::AllWhenGpu,
        // Surya ships its own chat template; without --jinja llama.cpp falls back to a
        // generic one and the model answers in prose instead of the trained format.
        jinja: true,
        alias: None,
    },
    request: RequestSpec {
        system_prompt: None,
        temperature: 0.0,
        top_p: 1.0,
        top_k: Some(1),
        presence_penalty: None,
        stop: &[],
        enable_thinking: None,
        logprobs: true,
        top_logprobs: 0,
    },
    caps: Capabilities {
        vision: true,
        logprobs: true,
        grounding: Grounding::Cell,
        output_format: OutputFormat::SuryaTableJson,
    },
    roles: &[ModelRole::Ground],
    footprint: Footprint {
        weights_mb: 1_100, // ~650M params at Q8_0 plus its vision projector
        min_ram_mb: 16_384,
        min_vram_mb: None,
    },
    user_supplied: false,
};

/// The id reserved for the user's own GGUF. Not a real model until one is registered.
pub const CUSTOM_MODEL_ID: &str = "custom-gguf";

/// A GGUF the user supplied themselves.
///
/// Anchor knows nothing about this file beyond it being a GGUF: not its family, not
/// its chat template, not whether it has ever produced a TSV. So the spec is the most
/// conservative one that can still work, and every field is a deliberate refusal to
/// guess:
///
/// - **No system prompt and no stop tokens.** Qwen's are Qwen's; sending
///   `<|im_start|>` to a Llama or Gemma checkpoint is at best ignored and at worst
///   truncates the answer at the first token that happens to match.
/// - **`jinja: true`.** The model's own embedded chat template is the only one that
///   can be right, and llama.cpp's generic fallback is reliably wrong for instruct
///   models.
/// - **`vision: false`.** The page image is only attached when the user also supplies
///   a projector; the runtime turns this on for that case (see `pipeline::custom`).
///   Attaching an image to a text-only model is a hard server error, not a graceful
///   degradation.
/// - **No `Ground` role.** A model that has not been checked against the band format
///   cannot be trusted with the page's geometry, and `Grounding::None` makes the
///   validator enforce that rather than leaving it to a comment.
pub const CUSTOM_GGUF: ModelSpec = ModelSpec {
    id: CUSTOM_MODEL_ID,
    label: "Your own model",
    family: "custom",
    // Empty on purpose: the paths live in user config, not in the asset manifest.
    files: &[],
    launch: LaunchSpec {
        // Overridden by the registered config; this is the floor a model gets if the
        // user never says otherwise.
        ctx: 8192,
        image_min_tokens: None,
        parallel: 1,
        gpu_layers: GpuLayers::AllWhenGpu,
        jinja: true,
        alias: None,
    },
    request: RequestSpec {
        system_prompt: None,
        temperature: 0.0,
        top_p: 1.0,
        top_k: Some(1),
        presence_penalty: None,
        stop: &[],
        enable_thinking: None,
        // Kept on: a model that does not return logprobs simply yields unscored cells
        // (the confidence stage already handles `None`), whereas leaving it off would
        // silently discard a signal a capable model was willing to give.
        logprobs: true,
        top_logprobs: 0,
    },
    caps: Capabilities {
        vision: false,
        logprobs: true,
        grounding: Grounding::None,
        output_format: OutputFormat::Tsv,
    },
    roles: &[ModelRole::Structure, ModelRole::Verify],
    footprint: Footprint {
        // Unknown until the file is on disk; the runtime reports the real size.
        weights_mb: 0,
        min_ram_mb: 8_192,
        min_vram_mb: None,
    },
    user_supplied: true,
};

/// Every model the app can run.
///
/// [`SURYA_OCR_2`] is **not here yet**, and its absence is enforced rather than
/// accidental: `setup.rs` pins the bytes of every listed model's files, and a test
/// asserts that list and this one cover each other exactly. Surya joins this array in
/// the same change that adds its SHA-256 pins — not before, because a model the
/// catalog offers and the installer cannot verify is exactly what the pinning
/// invariant exists to prevent.
pub const MODELS: &[ModelSpec] = &[QWEN_3_5_4B];

/// Today's pipeline, expressed as data. Running this preset must reproduce the
/// current behaviour exactly — it is the baseline the executor's equivalence test
/// compares against.
pub const TESSERACT_QWEN: PipelinePreset = PipelinePreset {
    id: "tesseract-qwen3.5-4b",
    label: "Fast",
    description: "Tesseract reads the page, Qwen3.5 4B builds the table. Lowest memory use.",
    version: 1,
    requires: Requirements {
        min_ram_mb: 8_192,
        min_vram_mb: None,
    },
    steps: &[
        Step::Render {
            target_width: RENDER_TARGET_WIDTH,
        },
        Step::GroundTesseract {
            tesseract: TesseractSpec {
                psm: 6,
                lang: "eng",
            },
        },
        Step::Structure {
            model_id: QWEN_3_5_4B.id,
            prompt: PromptId::QwenTsvExtract,
            residency: Residency::Exclusive,
        },
    ],
};

/// Tesseract's words with Surya's grid, then Qwen builds the table.
///
/// The preset the P0 spike actually argues for. Tesseract is good at reading words and
/// bad at inferring where the columns are; Surya is the reverse — its bands were exact
/// while its own table markup contradicted them. Pairing them uses each for its strong
/// half, and costs one extra model call of about 200 tokens per page.
///
/// Both model steps are `Shared` rather than `Exclusive`, and that is a correctness
/// requirement, not a tuning choice: the executor runs steps per page, so evicting
/// between them would unload and reload multi-gigabyte weights *twice per page* on a
/// long document. The 16 GB floor is what pays for holding both — hence the RAM
/// requirement above what either model needs alone.
///
/// **Not in [`PRESETS`] yet** — it names [`SURYA_OCR_2`], whose downloads are not
/// pinned. It is validated by a test in the meantime so it cannot rot while it waits.
pub const TESSERACT_SURYA_QWEN: PipelinePreset = PipelinePreset {
    id: "tesseract-surya-qwen3.5-4b",
    label: "Accurate",
    description: "Tesseract reads the page, Surya maps the table's rows and columns, \
Qwen3.5 4B builds the table. Better on dense or irregular tables.",
    version: 1,
    requires: Requirements {
        min_ram_mb: 16_384,
        min_vram_mb: None,
    },
    steps: &[
        Step::Render {
            target_width: RENDER_TARGET_WIDTH,
        },
        Step::GroundTesseract {
            tesseract: TesseractSpec {
                psm: 6,
                lang: "eng",
            },
        },
        Step::GroundGrid {
            model_id: SURYA_OCR_2.id,
            prompt: PromptId::SuryaTableBands,
            residency: Residency::Shared,
        },
        Step::Structure {
            model_id: QWEN_3_5_4B.id,
            prompt: PromptId::QwenTsvExtract,
            residency: Residency::Shared,
        },
    ],
};

/// Every preset the app can run, **ordered most capable first**.
///
/// That ordering is load-bearing, not cosmetic: `hardware::recommend_preset` picks the
/// first entry a machine's RAM and VRAM satisfy, so inserting a new preset places it
/// in the recommendation ladder. A preset added in the wrong position silently becomes
/// the recommendation for machines that should have got something else.
pub const PRESETS: &[PipelinePreset] = &[TESSERACT_QWEN];

/// Tesseract grounds the page and the user's own model builds the table.
///
/// Deliberately **not** in [`PRESETS`], which is the list of pipelines Anchor ships:
/// this one cannot be recommended (nothing is known about the model's capability),
/// cannot be installed (its file is already on disk, chosen by the user), and must
/// not appear anywhere the shipped set is treated as verified. It is offered only
/// once a GGUF has been registered, and `preset()` resolves it so a run can name it.
pub const CUSTOM_PRESET: PipelinePreset = PipelinePreset {
    id: "custom-gguf",
    label: "Your own model",
    description: "Tesseract reads the page and a GGUF you supply builds the table. \
Anchor cannot verify this model or vouch for its output.",
    version: 1,
    requires: Requirements {
        min_ram_mb: 8_192,
        min_vram_mb: None,
    },
    steps: &[
        Step::Render {
            target_width: RENDER_TARGET_WIDTH,
        },
        Step::GroundTesseract {
            tesseract: TesseractSpec {
                psm: 6,
                lang: "eng",
            },
        },
        Step::Structure {
            model_id: CUSTOM_MODEL_ID,
            prompt: PromptId::TsvExtractTextOnly,
            residency: Residency::Exclusive,
        },
    ],
};

/// The preset used when nothing else is selected.
pub const DEFAULT_PRESET_ID: &str = TESSERACT_QWEN.id;

/// A model Anchor ships and installs. Excludes [`CUSTOM_GGUF`] on purpose — callers
/// that download, verify or size models must not see a model with no files.
pub fn model(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

/// Any model a *step* may name, including the user's own.
///
/// The split from [`model`] is the point: the executor has to resolve a custom model
/// to run it, while `setup.rs` and `hardware.rs` must never see one, because a model
/// with no pinned files would otherwise flow into a download list or a recommendation.
pub fn any_model(id: &str) -> Option<&'static ModelSpec> {
    model(id).or(if id == CUSTOM_MODEL_ID {
        Some(&CUSTOM_GGUF)
    } else {
        None
    })
}

pub fn preset(id: &str) -> Option<&'static PipelinePreset> {
    PRESETS
        .iter()
        .find(|p| p.id == id)
        .or(if id == CUSTOM_PRESET.id {
            Some(&CUSTOM_PRESET)
        } else {
            None
        })
}

/// Find the model file a setup asset id delivers.
///
/// This is the join between the catalog and the asset manifest, and it runs in this
/// direction on purpose: `setup.rs` is handed an `asset_id` and needs to know where
/// the file lands, which only the catalog knows. Keeping the mapping here means adding
/// a model is a catalog edit plus a pinned asset, with no third list to update.
pub fn model_file_by_asset(asset_id: &str) -> Option<&'static ModelFile> {
    MODELS
        .iter()
        .flat_map(|m| m.files.iter())
        .find(|f| f.asset_id == asset_id)
}

/// Every asset id the catalog's models need, deduplicated.
pub fn all_model_asset_ids() -> Vec<&'static str> {
    let mut ids = Vec::new();
    for file in MODELS.iter().flat_map(|m| m.files.iter()) {
        if !ids.contains(&file.asset_id) {
            ids.push(file.asset_id);
        }
    }
    ids
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Check a set of presets against a set of models, returning every problem found
/// rather than the first.
///
/// Takes its inputs as parameters rather than reading the statics directly so the
/// tests can feed it deliberately-broken catalogs — with one preset in the real
/// catalog, validating only the real data would prove almost nothing.
pub fn validate_catalog(
    presets: &[PipelinePreset],
    models: &[ModelSpec],
) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let find = |id: &str| -> Option<&ModelSpec> { models.iter().find(|m| m.id == id) };

    for (i, m) in models.iter().enumerate() {
        if models.iter().skip(i + 1).any(|o| o.id == m.id) {
            errors.push(format!("duplicate model id `{}`", m.id));
        }
        if m.roles.is_empty() {
            errors.push(format!("model `{}` has no roles", m.id));
        }
        // A user-supplied model's files are chosen at runtime and live in user config,
        // so there is nothing to declare here. Every other rule still applies to it —
        // notably the role and grounding checks below, which are what stop an
        // unverified model being handed the page's geometry.
        if !m.user_supplied {
            if m.file(FileRole::Weights).is_none() {
                errors.push(format!("model `{}` has no weights file", m.id));
            }
            if m.caps.vision && m.file(FileRole::Mmproj).is_none() {
                errors.push(format!(
                    "model `{}` is vision-capable but has no mmproj file",
                    m.id
                ));
            }
        }
        if m.allows(ModelRole::Ground) && !m.caps.grounding.is_usable_for_grounding() {
            errors.push(format!(
                "model `{}` claims the ground role but reports no locations",
                m.id
            ));
        }
        if m.launch.ctx == 0 {
            errors.push(format!("model `{}` has a zero context size", m.id));
        }
    }

    for (i, p) in presets.iter().enumerate() {
        if presets.iter().skip(i + 1).any(|o| o.id == p.id) {
            errors.push(format!("duplicate preset id `{}`", p.id));
        }

        match p.steps.first() {
            Some(Step::Render { .. }) => {}
            _ => errors.push(format!("preset `{}` must start with a render step", p.id)),
        }

        let grounding_steps = p.steps.iter().filter(|s| s.supplies_items()).count();
        if grounding_steps != 1 {
            errors.push(format!(
                "preset `{}` must have exactly one grounding step, found {grounding_steps}",
                p.id
            ));
        }

        let grid_steps = p.steps.iter().filter(|s| s.supplies_grid()).count();
        if grid_steps > 1 {
            errors.push(format!(
                "preset `{}` has {grid_steps} grid steps; a table has one grid",
                p.id
            ));
        }
        // A grid step refines the items an earlier step produced, so it has to run
        // after them and before anything consumes the pair.
        if let Some(grid_at) = p.steps.iter().position(Step::supplies_grid) {
            let items_at = p.steps.iter().position(Step::supplies_items);
            if items_at.is_none_or(|items| items >= grid_at) {
                errors.push(format!(
                    "preset `{}` asks for a grid before anything grounded the page",
                    p.id
                ));
            }
            if p.steps[..grid_at]
                .iter()
                .any(|s| matches!(s, Step::Structure { .. }))
            {
                errors.push(format!(
                    "preset `{}` asks for a grid after the table was already built",
                    p.id
                ));
            }
        }

        if !p.steps.iter().any(|s| matches!(s, Step::Structure { .. })) {
            errors.push(format!("preset `{}` has no structure step", p.id));
        }

        let first_structure = p
            .steps
            .iter()
            .position(|s| matches!(s, Step::Structure { .. }));
        if let Some(first_verify) = p
            .steps
            .iter()
            .position(|s| matches!(s, Step::Verify { .. }))
        {
            match first_structure {
                Some(fs) if fs < first_verify => {}
                _ => errors.push(format!(
                    "preset `{}` has a verify step with no preceding structure step",
                    p.id
                )),
            }
        }

        for step in p.steps {
            let Some(id) = step.model_id() else { continue };
            let Some(spec) = find(id) else {
                errors.push(format!("preset `{}` references unknown model `{id}`", p.id));
                continue;
            };
            if let Some(role) = step.required_role() {
                if !spec.allows(role) {
                    errors.push(format!(
                        "preset `{}` uses model `{id}` for a {role:?} step, but its roles are {:?}",
                        p.id, spec.roles
                    ));
                }
            }
            if matches!(step, Step::GroundModel { .. })
                && !spec.caps.grounding.is_usable_for_grounding()
            {
                errors.push(format!(
                    "preset `{}` grounds on model `{id}`, which reports no locations",
                    p.id
                ));
            }
            // Bands are a strictly stronger claim than "reports locations": a model
            // that can only outline blocks has no rows or columns to give.
            if matches!(step, Step::GroundGrid { .. }) && spec.caps.grounding != Grounding::Cell {
                errors.push(format!(
                    "preset `{}` asks model `{id}` for a table grid, but it reports {:?} boxes",
                    p.id, spec.caps.grounding
                ));
            }
        }

        if p.requires.min_ram_mb == 0 {
            errors.push(format!("preset `{}` declares no RAM requirement", p.id));
        }
        for id in p.model_ids() {
            if let Some(spec) = find(id) {
                if spec.footprint.min_ram_mb > p.requires.min_ram_mb {
                    errors.push(format!(
                        "preset `{}` requires {} MB RAM but model `{id}` needs {}",
                        p.id, p.requires.min_ram_mb, spec.footprint.min_ram_mb
                    ));
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the real catalog ----

    #[test]
    fn bundled_catalog_is_valid() {
        if let Err(errors) = validate_catalog(PRESETS, MODELS) {
            panic!("bundled catalog is invalid:\n  {}", errors.join("\n  "));
        }
    }

    #[test]
    fn default_preset_exists_and_is_word_grounded() {
        let p = preset(DEFAULT_PRESET_ID).expect("default preset must be in the catalog");
        assert!(p.uses_tesseract());
        assert_eq!(p.grounding(), Grounding::Word);
        assert_eq!(p.model_ids(), vec!["qwen3.5-4b"]);
    }

    #[test]
    fn every_prompt_id_has_non_empty_text() {
        for id in [
            PromptId::QwenTsvExtract,
            PromptId::QwenExtractSystem,
            PromptId::SuryaOcrHtml,
            PromptId::SuryaTableBands,
        ] {
            assert!(!prompt_text(id).is_empty(), "{id:?} has no text");
        }
    }

    /// The spatial OCR text is appended to this prompt with no separator, so the
    /// ending is part of the contract, not formatting.
    #[test]
    fn tsv_prompt_ends_with_the_ocr_marker() {
        assert!(prompt_text(PromptId::QwenTsvExtract).ends_with("\n\nOCR text:\n"));
    }

    /// Guards the TSV-not-CSV decision (design.md §4) against a well-meaning edit.
    #[test]
    fn tsv_prompt_demands_tabs_and_forbids_markdown() {
        let p = prompt_text(PromptId::QwenTsvExtract);
        assert!(p.starts_with("Return only TSV"));
        assert!(p.contains("tab character"));
        assert!(p.contains("no code fences, no markdown"));
    }

    /// Surya's prompts are training-time contracts recovered from its source; a
    /// paraphrase changes the output shape. Pinned verbatim.
    #[test]
    fn surya_prompts_are_verbatim() {
        assert_eq!(
            prompt_text(PromptId::SuryaOcrHtml),
            "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000)."
        );
        assert_eq!(
            prompt_text(PromptId::SuryaTableBands),
            "Output the table rows then columns as JSON. Each entry is a dict with \"label\" (\"Row\" or \"Col\") and \"bbox\" (x0 y0 x1 y1, normalized 0-1000)."
        );
    }

    /// The default preset must keep reproducing today's behaviour, so the values
    /// that reach `llama-server` and the request body are pinned here. If one of
    /// these changes, the change was either deliberate (update both sides) or a
    /// silent regression in the pipeline the equivalence test will later compare.
    #[test]
    fn qwen_spec_mirrors_the_current_hardcoded_values() {
        let m = QWEN_3_5_4B;
        assert_eq!(m.launch.ctx, 8192); // DEFAULT_CTX_SIZE in llama.rs
        assert_eq!(m.launch.image_min_tokens, Some(1024)); // DEFAULT_IMAGE_MIN_TOKENS
        assert_eq!(m.launch.parallel, 1); // DEFAULT_N_PARALLEL
        assert!(!m.launch.jinja);
        assert_eq!(m.request.temperature, 0.0);
        assert_eq!(m.request.top_p, 1.0);
        assert_eq!(m.request.top_k, Some(1));
        assert_eq!(m.request.presence_penalty, Some(0.0));
        assert_eq!(m.request.stop, &["<|im_start|>", "<|im_end|>"]);
        assert_eq!(m.request.enable_thinking, Some(false));
        assert!(m.request.logprobs);
        assert_eq!(m.request.top_logprobs, 0);
    }

    /// Qwen keeps its historical flat filenames so existing installs need no
    /// filesystem migration.
    #[test]
    fn qwen_files_use_the_legacy_flat_paths() {
        let m = QWEN_3_5_4B;
        assert_eq!(
            m.file(FileRole::Weights).unwrap().relative_path,
            MODEL_FILENAME
        );
        assert_eq!(
            m.file(FileRole::Mmproj).unwrap().relative_path,
            MMPROJ_FILENAME
        );
        assert!(!MODEL_FILENAME.contains('/'), "flat, not nested");
    }

    #[test]
    fn render_width_matches_the_ocr_pipeline() {
        assert_eq!(RENDER_TARGET_WIDTH, 2000);
    }

    #[test]
    fn grounding_none_is_not_usable() {
        assert!(!Grounding::None.is_usable_for_grounding());
        for g in [Grounding::Block, Grounding::Word, Grounding::Cell] {
            assert!(g.is_usable_for_grounding());
        }
    }

    // ---- the validator itself, against deliberately-broken catalogs ----
    //
    // The real catalog has one preset, so validating only that would prove very
    // little. These construct the violations the rules exist to catch.

    const GROUNDER: ModelSpec = ModelSpec {
        id: "grounder",
        label: "Test grounder",
        family: "test",
        files: &[ModelFile {
            role: FileRole::Weights,
            asset_id: "g",
            relative_path: "g.gguf",
        }],
        launch: LaunchSpec {
            ctx: 4096,
            image_min_tokens: None,
            parallel: 1,
            gpu_layers: GpuLayers::AllWhenGpu,
            jinja: true,
            alias: None,
        },
        request: RequestSpec {
            system_prompt: None,
            temperature: 0.0,
            top_p: 0.1,
            top_k: None,
            presence_penalty: None,
            stop: &[],
            enable_thinking: None,
            logprobs: true,
            top_logprobs: 0,
        },
        caps: Capabilities {
            vision: false,
            logprobs: true,
            grounding: Grounding::Cell,
            output_format: OutputFormat::SuryaTableJson,
        },
        roles: &[ModelRole::Ground],
        footprint: Footprint {
            weights_mb: 1_500,
            min_ram_mb: 8_192,
            min_vram_mb: None,
        },
        user_supplied: false,
    };

    const RENDER: Step = Step::Render {
        target_width: RENDER_TARGET_WIDTH,
    };
    const TESS: Step = Step::GroundTesseract {
        tesseract: TesseractSpec {
            psm: 6,
            lang: "eng",
        },
    };
    const STRUCT_QWEN: Step = Step::Structure {
        model_id: "qwen3.5-4b",
        prompt: PromptId::QwenTsvExtract,
        residency: Residency::Exclusive,
    };

    fn bad(steps: &'static [Step]) -> PipelinePreset {
        PipelinePreset {
            id: "under-test",
            label: "Under test",
            description: "",
            version: 1,
            requires: Requirements {
                min_ram_mb: 8_192,
                min_vram_mb: None,
            },
            steps,
        }
    }

    fn errors_for(preset: PipelinePreset, models: &[ModelSpec]) -> Vec<String> {
        validate_catalog(&[preset], models).expect_err("expected validation to fail")
    }

    fn assert_reports(errors: &[String], needle: &str) {
        assert!(
            errors.iter().any(|e| e.contains(needle)),
            "expected an error containing {needle:?}, got: {errors:?}"
        );
    }

    #[test]
    fn rejects_a_model_used_for_a_role_it_does_not_hold() {
        // Qwen is structure/verify/chat — never a grounder.
        let errs = errors_for(
            bad(&[
                RENDER,
                Step::GroundModel {
                    model_id: "qwen3.5-4b",
                    prompt: PromptId::SuryaTableBands,
                    residency: Residency::Exclusive,
                },
                STRUCT_QWEN,
            ]),
            MODELS,
        );
        assert_reports(&errs, "for a Ground step");
        assert_reports(&errs, "reports no locations");
    }

    #[test]
    fn rejects_an_unknown_model_id() {
        let errs = errors_for(
            bad(&[
                RENDER,
                TESS,
                Step::Structure {
                    model_id: "does-not-exist",
                    prompt: PromptId::QwenTsvExtract,
                    residency: Residency::Exclusive,
                },
            ]),
            MODELS,
        );
        assert_reports(&errs, "unknown model `does-not-exist`");
    }

    #[test]
    fn rejects_a_preset_that_does_not_start_with_render() {
        let errs = errors_for(bad(&[TESS, STRUCT_QWEN]), MODELS);
        assert_reports(&errs, "must start with a render step");
    }

    #[test]
    fn rejects_zero_or_two_grounding_steps() {
        assert_reports(
            &errors_for(bad(&[RENDER, STRUCT_QWEN]), MODELS),
            "exactly one grounding step, found 0",
        );

        const TWO: &[Step] = &[
            RENDER,
            TESS,
            Step::GroundModel {
                model_id: "grounder",
                prompt: PromptId::SuryaTableBands,
                residency: Residency::Exclusive,
            },
            STRUCT_QWEN,
        ];
        let models = [QWEN_3_5_4B, GROUNDER];
        assert_reports(
            &errors_for(bad(TWO), &models),
            "exactly one grounding step, found 2",
        );
    }

    #[test]
    fn rejects_a_preset_with_no_structure_step() {
        let errs = errors_for(bad(&[RENDER, TESS]), MODELS);
        assert_reports(&errs, "no structure step");
    }

    #[test]
    fn rejects_a_verify_step_before_any_structure_step() {
        let errs = errors_for(
            bad(&[
                RENDER,
                TESS,
                Step::Verify {
                    model_id: "qwen3.5-4b",
                    prompt: PromptId::QwenTsvExtract,
                    residency: Residency::Exclusive,
                },
                STRUCT_QWEN,
            ]),
            MODELS,
        );
        assert_reports(&errs, "verify step with no preceding structure step");
    }

    #[test]
    fn accepts_a_verify_step_after_a_structure_step() {
        const OK: &[Step] = &[
            RENDER,
            Step::GroundModel {
                model_id: "grounder",
                prompt: PromptId::SuryaTableBands,
                residency: Residency::Exclusive,
            },
            STRUCT_QWEN,
            Step::Verify {
                model_id: "qwen3.5-4b",
                prompt: PromptId::QwenTsvExtract,
                residency: Residency::Shared,
            },
        ];
        let models = [QWEN_3_5_4B, GROUNDER];
        validate_catalog(&[bad(OK)], &models).expect("a ground→structure→verify preset is valid");
        assert_eq!(bad(OK).grounding(), Grounding::None); // `grounder` isn't in the real MODELS
    }

    // ---- the user's own model ----

    #[test]
    fn the_custom_preset_is_valid_against_the_custom_model() {
        let models = [QWEN_3_5_4B, CUSTOM_GGUF];
        if let Err(errors) = validate_catalog(&[CUSTOM_PRESET], &models) {
            panic!("the custom preset is invalid:\n  {}", errors.join("\n  "));
        }
    }

    /// The shipped lists are what gets recommended, downloaded and verified. A model
    /// with no pinned files and a preset Anchor cannot vouch for must not appear in
    /// either, or they flow into an install plan or a hardware recommendation.
    #[test]
    fn the_custom_model_and_preset_stay_out_of_the_shipped_lists() {
        assert!(!MODELS.iter().any(|m| m.id == CUSTOM_MODEL_ID));
        assert!(!PRESETS.iter().any(|p| p.id == CUSTOM_PRESET.id));
        assert!(model(CUSTOM_MODEL_ID).is_none(), "not an installable model");

        // But a run must still be able to name them.
        assert!(any_model(CUSTOM_MODEL_ID).is_some());
        assert_eq!(
            preset(CUSTOM_PRESET.id).map(|p| p.id),
            Some(CUSTOM_PRESET.id)
        );
    }

    #[test]
    fn any_model_does_not_invent_models() {
        assert!(any_model("no-such-model").is_none());
        assert_eq!(any_model("qwen3.5-4b").map(|m| m.id), Some("qwen3.5-4b"));
    }

    /// An unverified model must never be handed the page's geometry. `Grounding::None`
    /// is what makes the validator enforce that rather than a comment asking nicely.
    #[test]
    fn a_user_supplied_model_may_not_ground_the_page() {
        assert!(!CUSTOM_GGUF.allows(ModelRole::Ground));
        assert_eq!(CUSTOM_GGUF.caps.grounding, Grounding::None);

        let errs = errors_for(
            bad(&[
                RENDER,
                Step::GroundModel {
                    model_id: CUSTOM_MODEL_ID,
                    prompt: PromptId::SuryaOcrHtml,
                    residency: Residency::Exclusive,
                },
                STRUCT_QWEN,
            ]),
            &[QWEN_3_5_4B, CUSTOM_GGUF],
        );
        assert_reports(&errs, "reports no locations");
    }

    /// Nothing is known about an arbitrary GGUF's chat format, so the request carries
    /// no borrowed Qwen-isms: another model's stop tokens would at best be ignored and
    /// at worst cut the answer off at the first coincidental match.
    #[test]
    fn a_user_supplied_model_borrows_no_other_models_conventions() {
        // Resolved through `any_model` rather than read off the constant: that is the
        // spec the executor actually gets, and a field read on a `const` folds to a
        // literal that clippy rejects asserting on.
        let m = any_model(CUSTOM_MODEL_ID).expect("the custom model must resolve");
        assert!(m.request.stop.is_empty());
        assert!(m.request.system_prompt.is_none());
        assert!(m.request.enable_thinking.is_none());
        // Its own embedded template is the only one that can be right.
        assert!(m.launch.jinja);
        // And it declares no files: they live in user config, not the manifest.
        assert!(m.files.is_empty());
        assert!(m.user_supplied);
    }

    /// Telling a model to consult an attached image that is not there is worse than
    /// not mentioning one, so the custom preset uses the text-only prompt.
    #[test]
    fn the_custom_preset_asks_for_a_table_without_promising_an_image() {
        let prompt = match CUSTOM_PRESET.steps.last() {
            Some(Step::Structure { prompt, .. }) => *prompt,
            other => panic!("the custom preset must end in a structure step: {other:?}"),
        };
        assert_eq!(prompt, PromptId::TsvExtractTextOnly);

        let text = prompt_text(prompt);
        assert!(
            !text.contains("image"),
            "text-only prompt mentions an image"
        );
        assert!(!text.contains("attached"));
        // It is still the same task, and still ends with the load-bearing marker the
        // spatial OCR text is appended to.
        assert!(text.starts_with("Return only TSV"));
        assert!(text.contains("tab character"));
        assert!(text.ends_with("\n\nOCR text:\n"));
    }

    /// The custom model is not vision-capable, which is what stops the executor
    /// attaching a page image and what stops the budget charging for one.
    #[test]
    fn a_user_supplied_model_is_not_assumed_to_read_images() {
        let m = any_model(CUSTOM_MODEL_ID).expect("the custom model must resolve");
        assert!(!m.caps.vision);
    }

    // ---- the grid axis ----

    /// The preset waiting on Surya's pins must stay valid while it waits, or it rots
    /// into a change nobody can land without first debugging it.
    #[test]
    fn the_unshipped_grid_preset_is_valid_against_its_models() {
        let models = [QWEN_3_5_4B, SURYA_OCR_2];
        if let Err(errors) = validate_catalog(&[TESSERACT_SURYA_QWEN], &models) {
            panic!(
                "the words-plus-grid preset is invalid:\n  {}",
                errors.join("\n  ")
            );
        }
    }

    /// The point of the pairing: Tesseract's words *and* a declared grid. Box
    /// precision must stay at `word` — bands say where the columns are, not where a
    /// value's glyphs are, so reporting `cell` here would make the UI draw a coarser
    /// highlight than it actually has.
    #[test]
    fn a_grid_step_declares_a_grid_without_changing_box_precision() {
        assert!(TESSERACT_SURYA_QWEN.declares_grid());
        assert_eq!(TESSERACT_SURYA_QWEN.grounding(), Grounding::Word);
        assert!(TESSERACT_SURYA_QWEN.uses_tesseract());

        // Today's preset declares no grid, so it keeps inferring one.
        assert!(!TESSERACT_QWEN.declares_grid());
    }

    /// Both models stay resident. Evicting between them would unload and reload
    /// multi-gigabyte weights *twice per page*, because the executor runs steps per
    /// page — which would make the accurate preset slower than re-typing the table.
    #[test]
    fn the_grid_preset_keeps_both_models_resident() {
        for step in TESSERACT_SURYA_QWEN.steps {
            match step {
                Step::GroundGrid { residency, .. } | Step::Structure { residency, .. } => {
                    assert!(
                        matches!(residency, Residency::Shared),
                        "a two-model preset must not swap per step: {step:?}"
                    );
                }
                _ => {}
            }
        }
        assert_eq!(
            TESSERACT_SURYA_QWEN.model_ids(),
            vec!["surya-ocr-2", "qwen3.5-4b"]
        );
    }

    /// Surya is a grounder, not a structurer. Its `ocr` mode does return text, and the
    /// P0 spike found that text internally inconsistent with its own geometry — so the
    /// catalog withholds the role rather than trusting it not to be asked.
    #[test]
    fn surya_may_only_ground() {
        assert!(SURYA_OCR_2.allows(ModelRole::Ground));
        assert!(!SURYA_OCR_2.allows(ModelRole::Structure));
        assert!(!SURYA_OCR_2.allows(ModelRole::Verify));

        let errs = errors_for(
            bad(&[
                RENDER,
                TESS,
                Step::Structure {
                    model_id: "surya-ocr-2",
                    prompt: PromptId::QwenTsvExtract,
                    residency: Residency::Shared,
                },
            ]),
            &[QWEN_3_5_4B, SURYA_OCR_2],
        );
        assert_reports(&errs, "for a Structure step");
    }

    /// Surya needs `--jinja`: without its own chat template llama.cpp applies a
    /// generic one and the model answers in prose instead of the trained band format.
    #[test]
    fn a_vision_grounder_ships_a_projector_and_its_own_template() {
        // Written as a rule over a list rather than assertions on the constant: clippy
        // folds a field read on a `const` into a literal and rejects the assertion as
        // tautological, and a rule is what the next grounding model needs anyway.
        const GROUNDERS: &[ModelSpec] = &[SURYA_OCR_2];
        for m in GROUNDERS {
            assert!(m.launch.jinja, "`{}` needs its own chat template", m.id);
            assert!(m.caps.vision, "`{}` reads pages", m.id);
            assert!(
                m.file(FileRole::Mmproj).is_some(),
                "`{}` is vision-capable and needs a projector",
                m.id
            );
        }
    }

    #[test]
    fn rejects_a_grid_step_on_a_model_that_cannot_report_bands() {
        // Block-level boxes are not rows and columns. A model that only outlines
        // regions has no grid to give, and accepting one would produce a confident
        // grid built from nothing.
        const BLOCKY: ModelSpec = ModelSpec {
            id: "blocky",
            caps: Capabilities {
                vision: false,
                logprobs: true,
                grounding: Grounding::Block,
                output_format: OutputFormat::SuryaHtml,
            },
            ..GROUNDER
        };
        let errs = errors_for(
            bad(&[
                RENDER,
                TESS,
                Step::GroundGrid {
                    model_id: "blocky",
                    prompt: PromptId::SuryaTableBands,
                    residency: Residency::Shared,
                },
                STRUCT_QWEN,
            ]),
            &[QWEN_3_5_4B, BLOCKY],
        );
        assert_reports(&errs, "asks model `blocky` for a table grid");
    }

    #[test]
    fn rejects_a_grid_step_before_anything_grounded_the_page() {
        const GRID: Step = Step::GroundGrid {
            model_id: "grounder",
            prompt: PromptId::SuryaTableBands,
            residency: Residency::Shared,
        };
        let models = [QWEN_3_5_4B, GROUNDER];
        assert_reports(
            &errors_for(bad(&[RENDER, GRID, TESS, STRUCT_QWEN]), &models),
            "before anything grounded the page",
        );
    }

    #[test]
    fn rejects_a_grid_step_after_the_table_was_built() {
        const GRID: Step = Step::GroundGrid {
            model_id: "grounder",
            prompt: PromptId::SuryaTableBands,
            residency: Residency::Shared,
        };
        let models = [QWEN_3_5_4B, GROUNDER];
        assert_reports(
            &errors_for(bad(&[RENDER, TESS, STRUCT_QWEN, GRID]), &models),
            "after the table was already built",
        );
    }

    #[test]
    fn rejects_two_grid_steps() {
        const GRID: Step = Step::GroundGrid {
            model_id: "grounder",
            prompt: PromptId::SuryaTableBands,
            residency: Residency::Shared,
        };
        let models = [QWEN_3_5_4B, GROUNDER];
        assert_reports(
            &errors_for(bad(&[RENDER, TESS, GRID, GRID, STRUCT_QWEN]), &models),
            "a table has one grid",
        );
    }

    /// A grid step must not be mistaken for a second *grounding* step — that rule
    /// counts the sources of located text, and a grid contributes none.
    #[test]
    fn a_grid_step_does_not_count_as_a_second_grounding_step() {
        let models = [QWEN_3_5_4B, GROUNDER];
        const OK: &[Step] = &[
            RENDER,
            TESS,
            Step::GroundGrid {
                model_id: "grounder",
                prompt: PromptId::SuryaTableBands,
                residency: Residency::Shared,
            },
            STRUCT_QWEN,
        ];
        validate_catalog(&[bad(OK)], &models).expect("words plus a declared grid is valid");
    }

    #[test]
    fn rejects_a_model_claiming_ground_without_locations() {
        const BLIND: ModelSpec = ModelSpec {
            id: "blind",
            caps: Capabilities {
                vision: false,
                logprobs: true,
                grounding: Grounding::None,
                output_format: OutputFormat::Tsv,
            },
            roles: &[ModelRole::Ground],
            ..GROUNDER
        };
        let errs = validate_catalog(&[TESSERACT_QWEN], &[QWEN_3_5_4B, BLIND])
            .expect_err("a sightless grounder must be rejected");
        assert_reports(&errs, "claims the ground role but reports no locations");
    }

    #[test]
    fn rejects_a_preset_whose_ram_floor_is_below_its_models() {
        let thin = PipelinePreset {
            requires: Requirements {
                min_ram_mb: 2_048,
                min_vram_mb: None,
            },
            ..TESSERACT_QWEN
        };
        let errs = errors_for(thin, MODELS);
        assert_reports(&errs, "requires 2048 MB RAM but model");
    }

    #[test]
    fn rejects_duplicate_ids() {
        let errs = validate_catalog(&[TESSERACT_QWEN, TESSERACT_QWEN], MODELS)
            .expect_err("duplicate preset ids must be rejected");
        assert_reports(&errs, "duplicate preset id");

        let errs = validate_catalog(PRESETS, &[QWEN_3_5_4B, QWEN_3_5_4B])
            .expect_err("duplicate model ids must be rejected");
        assert_reports(&errs, "duplicate model id");
    }

    #[test]
    fn reports_every_problem_not_just_the_first() {
        // No render, no grounding, no structure — three distinct rules broken.
        let errs = errors_for(bad(&[]), MODELS);
        assert!(errs.len() >= 3, "expected several errors, got: {errs:?}");
    }

    /// The wire format is shared with the frontend, so the tagged-enum shape of a
    /// step and the snake_case of the capability vocabulary are a contract.
    #[test]
    fn steps_serialize_with_a_kind_tag() {
        let json = serde_json::to_string(&TESSERACT_QWEN).expect("preset must serialize");
        assert!(json.contains(r#""kind":"render""#));
        assert!(json.contains(r#""kind":"ground_tesseract""#));
        assert!(json.contains(r#""kind":"structure""#));
        assert!(json.contains(r#""model_id":"qwen3.5-4b""#));
    }
}
