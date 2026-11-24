//! The user's own GGUF: registering one, validating it, and remembering it.
//!
//! Anchor's bundled models are pinned by SHA-256 and verified on download
//! (`setup.rs::MODEL_ASSETS`). This is the deliberate escape hatch from that, for
//! people who want to run a checkpoint Anchor does not ship — and because it is an
//! escape hatch, its boundaries matter more than its features.
//!
//! # What this will not accept
//!
//! **Local files only. Never a URL, never a path that is not already on disk.** The
//! rule is not a formatting preference: a registration that accepted a remote address
//! would turn a settings field into an arbitrary-download primitive, reachable from
//! the webview, bypassing every pin in the installer. [`validate_gguf`] therefore
//! demands an absolute path to an existing regular file — a URL fails all three
//! checks, and it is tested that it does.
//!
//! # Why the magic bytes are checked
//!
//! The path reaches `llama-server` as the value of `-m`. That is *data* passed to a
//! fixed binary resolved from AppData, never something executed — the hardening in
//! `llama.rs` is what guarantees the binary itself cannot be chosen from the webview.
//! Reading the four-byte `GGUF` header on top of that is defence in depth: it means a
//! mis-picked file, or a path pointed somewhere surprising, is refused *here* with a
//! clear message rather than becoming a confusing server crash three screens later.
//!
//! # What is remembered
//!
//! The registration is persisted to AppData, not to webview storage, and the launch
//! path is read back from there at spawn time. So the webview never hands a path to a
//! process spawn: it hands one to a validator, once, and the validator decides.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::paths::resolve_data_dir;

/// The registration file, beside the backend and preset choices.
const CUSTOM_MODEL_FILENAME: &str = "custom_model.json";

/// Every GGUF starts with these four bytes.
const GGUF_MAGIC: &[u8; 4] = b"GGUF";

/// Context sizes we will accept. The floor is roughly a page of spatial OCR text plus
/// its table; the ceiling exists because `-c` allocates a KV cache up front, and a
/// mistyped extra digit would otherwise ask the OS for hundreds of gigabytes and take
/// the app down with it.
const MIN_CTX: u32 = 2048;
const MAX_CTX: u32 = 131_072;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomModel {
    pub weights_path: String,
    pub ctx: u32,
    /// Size of the weights file, for the settings UI. Recorded at registration rather
    /// than re-read on every load: it is a display detail, and a file that has since
    /// been moved should surface as a launch error, not as a settings page that
    /// silently shows nothing.
    #[serde(default)]
    pub weights_bytes: u64,
}

/// Reject anything that is not an existing local GGUF.
///
/// Every branch here is a refusal rather than a repair. A path that "looks like" a
/// model is not one, and the cost of guessing wrong lands on a process spawn.
pub fn validate_gguf(path: &str, label: &str) -> Result<u64, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("No {label} file was chosen."));
    }

    // A URL is not a path. Checked explicitly and first, so the error says what is
    // actually wrong instead of "file not found" — and so the rule is visible in the
    // code rather than being an emergent property of the checks below.
    if let Some(scheme) = url_scheme(trimmed) {
        return Err(format!(
            "The {label} must be a file already on this computer. \
             Anchor will not download from `{scheme}` — bundled models are the only ones it verifies."
        ));
    }

    let candidate = Path::new(trimmed);
    if !candidate.is_absolute() {
        return Err(format!("The {label} path must be a full path to the file."));
    }

    let metadata = std::fs::metadata(candidate)
        .map_err(|_| format!("The {label} file could not be found at that path."))?;
    if !metadata.is_file() {
        return Err(format!("The {label} path is not a file."));
    }

    if !candidate
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("gguf"))
    {
        return Err(format!("The {label} must be a .gguf file."));
    }

    if !starts_with_gguf_magic(candidate) {
        return Err(
            "That file is not a GGUF model — its contents do not match the \
                    format, whatever the name says."
                .into(),
        );
    }

    Ok(metadata.len())
}

/// The scheme of a URL-looking string, if it has one.
///
/// Deliberately broader than `http`/`https`: `file://`, `ftp://` and anything else
/// with a scheme are all refused, because the point is that only a plain local path
/// is understood. A Windows drive letter (`C:\...`) is not a scheme and must survive,
/// which is what the length check is for.
fn url_scheme(value: &str) -> Option<&str> {
    let (scheme, rest) = value.split_once(':')?;
    if !rest.starts_with("//") || scheme.len() < 2 {
        return None;
    }
    scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
        .then_some(scheme)
}

fn starts_with_gguf_magic(path: &Path) -> bool {
    use std::io::Read as _;
    let mut header = [0u8; 4];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut header))
        .is_ok()
        && &header == GGUF_MAGIC
}

fn config_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(resolve_data_dir(app_handle)?.join(CUSTOM_MODEL_FILENAME))
}

/// Read the registered model, or `None` when none is registered or the file is
/// unreadable. A corrupt registration reads as absent rather than failing the launch:
/// the user can always register again, and refusing to start over a JSON file they
/// cannot see would be the worse failure.
pub fn load(app_handle: &tauri::AppHandle) -> Option<CustomModel> {
    let path = config_path(app_handle).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Validate and register a user-supplied GGUF.
#[tauri::command]
pub fn set_custom_model(
    app_handle: tauri::AppHandle,
    weights_path: String,
    ctx: Option<u32>,
) -> Result<CustomModel, String> {
    let weights_bytes = validate_gguf(&weights_path, "model")?;

    let ctx = ctx.unwrap_or(crate::pipeline::catalog::CUSTOM_GGUF.launch.ctx);
    if !(MIN_CTX..=MAX_CTX).contains(&ctx) {
        return Err(format!(
            "The context size must be between {MIN_CTX} and {MAX_CTX} tokens."
        ));
    }

    let model = CustomModel {
        weights_path: weights_path.trim().to_owned(),
        ctx,
        weights_bytes,
    };

    let json = serde_json::to_string_pretty(&model)
        .map_err(|e| format!("failed to record the model: {e}"))?;
    std::fs::write(config_path(&app_handle)?, json)
        .map_err(|e| format!("failed to save the model choice: {e}"))?;
    Ok(model)
}

#[tauri::command]
pub fn get_custom_model(app_handle: tauri::AppHandle) -> Option<CustomModel> {
    load(&app_handle)
}

/// Forget the registered model. Removes only Anchor's record of it — the user's GGUF
/// is their file and is never touched.
#[tauri::command]
pub fn clear_custom_model(app_handle: tauri::AppHandle) -> Result<(), String> {
    let path = config_path(&app_handle)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to forget the model: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gguf(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, b"GGUF\x03\x00\x00\x00rest of the file").unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn accepts_an_existing_local_gguf_and_reports_its_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = gguf(dir.path(), "model.gguf");
        let size = validate_gguf(&path, "model").expect("a real GGUF must be accepted");
        assert_eq!(size, std::fs::metadata(&path).unwrap().len());
    }

    /// The boundary this whole module exists to hold. A registration that accepted a
    /// remote address would be an arbitrary-download primitive reachable from the
    /// webview, bypassing every pin in the installer.
    #[test]
    fn refuses_every_url_shape() {
        for url in [
            "https://example.com/model.gguf",
            "http://example.com/model.gguf",
            "HTTPS://EXAMPLE.COM/model.gguf",
            "file:///C:/models/model.gguf",
            "ftp://example.com/model.gguf",
            "smb://server/share/model.gguf",
        ] {
            let Err(err) = validate_gguf(url, "model") else {
                panic!("{url} must be refused");
            };
            assert!(
                err.contains("already on this computer"),
                "{url} was refused for the wrong reason: {err}"
            );
        }
    }

    /// A Windows path is not a URL, however much `C:` looks like a scheme.
    #[test]
    fn a_windows_drive_letter_is_not_a_url_scheme() {
        assert!(url_scheme(r"C:\models\model.gguf").is_none());
        assert!(url_scheme("/home/a/model.gguf").is_none());
        assert!(url_scheme("https://example.com").is_some());
    }

    #[test]
    fn refuses_a_relative_path() {
        let err = validate_gguf("models/model.gguf", "model").unwrap_err();
        assert!(err.contains("full path"), "{err}");
    }

    #[test]
    fn refuses_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.gguf");
        let err = validate_gguf(&missing.to_string_lossy(), "model").unwrap_err();
        assert!(err.contains("could not be found"), "{err}");
    }

    #[test]
    fn refuses_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("model.gguf");
        std::fs::create_dir(&sub).unwrap();
        let err = validate_gguf(&sub.to_string_lossy(), "model").unwrap_err();
        assert!(err.contains("not a file"), "{err}");
    }

    #[test]
    fn refuses_a_file_that_is_not_named_gguf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.bin");
        std::fs::write(&path, b"GGUF____").unwrap();
        let err = validate_gguf(&path.to_string_lossy(), "model").unwrap_err();
        assert!(err.contains(".gguf"), "{err}");
    }

    /// The check that makes the extension more than a naming convention: a renamed
    /// executable, a text file, a truncated download. Refused here with a clear
    /// message rather than becoming a server crash three screens later.
    #[test]
    fn refuses_a_file_whose_contents_are_not_a_gguf() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("renamed.gguf", &b"MZ\x90\x00this is a PE binary"[..]),
            ("text.gguf", &b"just some text"[..]),
            ("empty.gguf", &b""[..]),
            ("short.gguf", &b"GGU"[..]),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            let Err(err) = validate_gguf(&path.to_string_lossy(), "model") else {
                panic!("{name} must be refused");
            };
            assert!(err.contains("not a GGUF model"), "{name}: {err}");
        }
    }

    #[test]
    fn an_empty_path_names_the_field_that_is_missing() {
        assert!(validate_gguf("   ", "vision projector")
            .unwrap_err()
            .contains("vision projector"));
    }

    #[test]
    fn a_custom_model_round_trips_through_json_in_camel_case() {
        // The frontend reads this shape directly.
        let model = CustomModel {
            weights_path: "/models/m.gguf".into(),
            ctx: 4096,
            weights_bytes: 123,
        };
        let json = serde_json::to_string(&model).unwrap();
        assert!(json.contains("\"weightsPath\""), "{json}");
        assert!(json.contains("\"weightsBytes\""), "{json}");
        assert_eq!(
            serde_json::from_str::<CustomModel>(&json).unwrap(),
            model,
            "the registration must survive a round trip"
        );
    }

    /// A registration written by an older build, before a field existed.
    #[test]
    fn an_older_registration_without_optional_fields_still_loads() {
        let model: CustomModel =
            serde_json::from_str(r#"{"weightsPath":"/m.gguf","ctx":8192}"#).unwrap();
        assert_eq!(model.weights_bytes, 0);
    }
}
