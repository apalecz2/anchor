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
//! # Status
//!
//! Nothing executes this yet — the executor that walks these steps arrives in a
//! later phase. It is compiled and unit-tested from day one on purpose, for the
//! same reason `menu` is compiled on every platform: a catalog that isn't built
//! and checked is a catalog that rots. Hence the module-level `dead_code` allow.

#![allow(dead_code)]

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
            Step::GroundModel { .. } => Some(ModelRole::Ground),
            Step::Structure { .. } => Some(ModelRole::Structure),
            Step::Verify { .. } => Some(ModelRole::Verify),
        }
    }

    pub fn model_id(&self) -> Option<&'static str> {
        match self {
            Step::Render { .. } | Step::GroundTesseract { .. } => None,
            Step::GroundModel { model_id, .. }
            | Step::Structure { model_id, .. }
            | Step::Verify { model_id, .. } => Some(model_id),
        }
    }

    pub fn is_grounding(&self) -> bool {
        matches!(
            self,
            Step::GroundTesseract { .. } | Step::GroundModel { .. }
        )
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
    /// Derived from the grounding step rather than stored as a field, so the two
    /// cannot drift apart.
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
};

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

pub const PRESETS: &[PipelinePreset] = &[TESSERACT_QWEN];

/// The preset used when nothing else is selected.
pub const DEFAULT_PRESET_ID: &str = TESSERACT_QWEN.id;

pub fn model(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn preset(id: &str) -> Option<&'static PipelinePreset> {
    PRESETS.iter().find(|p| p.id == id)
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
        if m.file(FileRole::Weights).is_none() {
            errors.push(format!("model `{}` has no weights file", m.id));
        }
        if m.caps.vision && m.file(FileRole::Mmproj).is_none() {
            errors.push(format!(
                "model `{}` is vision-capable but has no mmproj file",
                m.id
            ));
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

        let grounding_steps = p.steps.iter().filter(|s| s.is_grounding()).count();
        if grounding_steps != 1 {
            errors.push(format!(
                "preset `{}` must have exactly one grounding step, found {grounding_steps}",
                p.id
            ));
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
