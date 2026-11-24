//! Hardware detection for backend selection.
//!
//! Probes the GPU (name/vendor/VRAM) and total RAM per platform and recommends a
//! llama.cpp backend (cuda / rocm / metal / cpu). All probing is best-effort:
//! failures degrade to "cpu" rather than erroring.

use std::process::Command;

use serde::Serialize;

use crate::pipeline::catalog::{self, PipelinePreset};

/// Build a `Command` that won't flash a console window on Windows. Anchor is a GUI
/// app, so shelling out to a probe (PowerShell, nvidia-smi) would otherwise pop a
/// visible console window on every launch during hardware detection. `CREATE_NO_WINDOW`
/// suppresses it. No-op on macOS/Linux (no console is created there).
fn hidden_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[derive(Serialize)]
pub struct HardwareInfo {
    pub gpu_name: Option<String>,
    pub gpu_vendor: Option<String>,
    pub vram_mb: Option<u64>,
    pub ram_mb: u64,
    pub recommended_backend: String,
    /// Platform string ("windows" | "macos" | "linux") so the wizard can present
    /// only the backends that actually ship an asset for this OS.
    pub os: String,
    /// Backends the user may choose in the custom installer on this platform,
    /// independent of the detected GPU (the wizard warns about mismatches).
    pub available_backends: Vec<String>,
    /// The pipeline preset this machine should run, chosen from the catalog by
    /// [`recommend_preset`]. The wizard pre-selects it; the user may override.
    pub recommended_preset: String,
    /// Every catalog preset with whether this machine meets its requirements, so the
    /// picker can show the ones it cannot run as *unavailable* rather than hiding
    /// them — a user comparing options needs to see what the machine rules out.
    pub presets: Vec<PresetAvailability>,
}

#[derive(Serialize)]
pub struct PresetAvailability {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Sum of every model's weights, in MB — the download the user is agreeing to.
    pub download_mb: u32,
    pub min_ram_mb: u32,
    pub min_vram_mb: Option<u32>,
    pub supported: bool,
}

/// `async` so Tauri runs it on the async runtime rather than the main (UI)
/// thread — a synchronous `#[tauri::command]` is invoked on the main thread, and
/// this one shells out to PowerShell/WMI, `nvidia-smi`, or `system_profiler`,
/// which routinely takes seconds. On the main thread that stalls the event loop,
/// so the window stops responding until the probe returns.
///
/// The probe itself is blocking process I/O, not async, so it goes to the
/// blocking pool via `spawn_blocking` instead of occupying an async worker
/// (same reasoning as `setup::verify_file_hash`).
#[tauri::command]
pub async fn detect_hardware() -> Result<HardwareInfo, String> {
    tokio::task::spawn_blocking(probe_hardware)
        .await
        .map_err(|error| format!("hardware probe failed: {error}"))
}

/// The probe itself, kept synchronous and separate from the command wrapper so
/// tests can call it directly without an async runtime.
pub(crate) fn probe_hardware() -> HardwareInfo {
    let (gpu_name, gpu_vendor, vram_mb, ram_mb) = query_hardware();
    let recommended_backend = recommend_backend(gpu_vendor.as_deref(), vram_mb);
    HardwareInfo {
        gpu_name,
        gpu_vendor,
        vram_mb,
        ram_mb,
        recommended_backend,
        os: current_os().into(),
        available_backends: available_backends(),
        recommended_preset: recommend_preset(ram_mb, vram_mb, catalog::PRESETS)
            .id
            .into(),
        presets: preset_availability(ram_mb, vram_mb, catalog::PRESETS),
    }
}

/// Whether a machine meets a preset's declared floor.
///
/// A preset that names no VRAM requirement runs anywhere; one that does is only
/// offered when VRAM was read *and* is sufficient. An unreadable VRAM figure counts
/// as insufficient here, which is the opposite of [`recommend_backend`]'s treatment of
/// the same `None` — deliberately. There, guessing wrong costs some speed; here it
/// costs a multi-gigabyte download for a pipeline the machine then cannot run.
pub(crate) fn meets(preset: &PipelinePreset, ram_mb: u64, vram_mb: Option<u64>) -> bool {
    if ram_mb < u64::from(preset.requires.min_ram_mb) {
        return false;
    }
    match preset.requires.min_vram_mb {
        None => true,
        Some(needed) => vram_mb.is_some_and(|have| have >= u64::from(needed)),
    }
}

/// Total weights a preset downloads, in MB.
pub(crate) fn download_mb(preset: &PipelinePreset) -> u32 {
    preset
        .model_ids()
        .iter()
        .filter_map(|id| catalog::model(id))
        .map(|m| m.footprint.weights_mb)
        .sum()
}

/// Pick the pipeline this machine should run: the first preset in catalog order whose
/// requirements it meets.
///
/// `ram_mb` was collected by every platform probe from the beginning and never used in
/// a decision; this is what it was collected for.
///
/// **`PRESETS` is ordered most-capable first** — that ordering is the ranking, and
/// `catalog.rs` says so beside the list. The alternative, inferring capability from
/// something measurable like total download size, reads plausibly and is wrong as soon
/// as two small specialized models outclass one large generalist. A separate `rank`
/// field would be a second source of truth that could quietly disagree with the steps.
///
/// Falls back to the least demanding preset when nothing qualifies: an unsupported
/// machine still has to be offered something, and the wizard shows the requirements it
/// failed beside it, so the user can see why it will struggle.
fn recommend_preset(
    ram_mb: u64,
    vram_mb: Option<u64>,
    presets: &'static [PipelinePreset],
) -> &'static PipelinePreset {
    presets
        .iter()
        .find(|p| meets(p, ram_mb, vram_mb))
        .or_else(|| presets.last())
        .unwrap_or(&catalog::TESSERACT_QWEN)
}

fn preset_availability(
    ram_mb: u64,
    vram_mb: Option<u64>,
    presets: &'static [PipelinePreset],
) -> Vec<PresetAvailability> {
    presets
        .iter()
        .map(|p| PresetAvailability {
            id: p.id.into(),
            label: p.label.into(),
            description: p.description.into(),
            download_mb: download_mb(p),
            min_ram_mb: p.requires.min_ram_mb,
            min_vram_mb: p.requires.min_vram_mb,
            supported: meets(p, ram_mb, vram_mb),
        })
        .collect()
}

/// Minimum VRAM (MB) before an NVIDIA GPU is worth the CUDA build over CPU.
const CUDA_MIN_VRAM_MB: u64 = 4096;

fn recommend_backend(vendor: Option<&str>, vram_mb: Option<u64>) -> String {
    let v = match vendor {
        Some(s) => s,
        None => return "cpu".into(),
    };
    if v.contains("NVIDIA") {
        // An NVIDIA GPU is present. Recommend CUDA unless we have a *reliable*
        // VRAM reading below the threshold. VRAM of None means detection was
        // unreliable (e.g. Win32_VideoController.AdapterRAM saturated near 4 GB
        // and nvidia-smi was unavailable) — in that case assume the card is
        // CUDA-capable rather than wrongly downgrading a capable GPU to CPU.
        return match vram_mb {
            Some(mb) if mb < CUDA_MIN_VRAM_MB => "cpu".into(),
            _ => "cuda".into(),
        };
    }
    if v.contains("AMD") {
        #[cfg(target_os = "linux")]
        return "rocm".into();
    }
    if v.contains("Apple") {
        return "metal".into();
    }
    "cpu".into()
}

/// Canonical platform string, shared with `install.rs` so the two commands can
/// never disagree about what OS they're running on.
pub fn current_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Backends with a downloadable asset on this platform, ordered best → fallback.
/// macOS ships only the Metal (Apple Silicon) build; the CPU/GPU split is a
/// Windows/Linux concern.
fn available_backends() -> Vec<String> {
    if cfg!(target_os = "macos") {
        vec!["metal".into()]
    } else if cfg!(target_os = "windows") {
        vec!["cuda".into(), "cpu".into()]
    } else {
        vec!["cuda".into(), "rocm".into(), "cpu".into()]
    }
}

/// Accurate total VRAM (MB) from nvidia-smi, which ships with the NVIDIA driver
/// on Windows and Linux. Used to bypass Win32_VideoController.AdapterRAM's 4 GB
/// uint32 saturation. Returns None if nvidia-smi is absent or unparseable.
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn nvidia_smi_vram_mb() -> Option<u64> {
    let out = hidden_command("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout))
}

/// Parse the first line of `nvidia-smi --query-gpu=memory.total
/// --format=csv,noheader,nounits` (a bare MB integer) into VRAM in MB. Split out as
/// a pure function so the saturation-bypass path (CR:H3) is unit-testable without a
/// real GPU. Returns None when the output is empty or unparseable.
#[cfg_attr(target_os = "macos", allow(dead_code))] // caller is win/linux-only
fn parse_nvidia_smi(stdout: &str) -> Option<u64> {
    stdout.lines().next()?.trim().parse::<u64>().ok()
}

fn extract_gpu_vendor(name: &str) -> &'static str {
    let u = name.to_uppercase();
    if u.contains("NVIDIA") {
        "NVIDIA"
    } else if u.contains("AMD") || u.contains("RADEON") {
        "AMD"
    } else if u.contains("APPLE") {
        "Apple"
    } else if u.contains("INTEL") {
        "Intel"
    } else {
        "Unknown"
    }
}

fn query_hardware() -> (Option<String>, Option<String>, Option<u64>, u64) {
    #[cfg(target_os = "windows")]
    return query_hardware_windows();

    #[cfg(target_os = "macos")]
    return query_hardware_macos();

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return query_hardware_linux();

    #[allow(unreachable_code)]
    (None, None, None, 0)
}

#[cfg(target_os = "windows")]
fn query_hardware_windows() -> (Option<String>, Option<String>, Option<u64>, u64) {
    let ps_gpu = r#"try { $g = Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 } | Sort-Object AdapterRAM -Descending | Select-Object -First 1; if ($g) { [pscustomobject]@{ Name=$g.Name; VRAM=$g.AdapterRAM } | ConvertTo-Json -Compress } else { '{}' } } catch { '{}' }"#;
    let ps_ram = r#"try { [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB) } catch { 0 }"#;

    let gpu_json = run_powershell(ps_gpu).unwrap_or_default();
    let gpu_val: serde_json::Value = serde_json::from_str(gpu_json.trim()).unwrap_or_default();
    let gpu_name = gpu_val["Name"].as_str().map(String::from);
    let gpu_vendor = gpu_name
        .as_deref()
        .map(extract_gpu_vendor)
        .map(String::from);

    // Win32_VideoController.AdapterRAM is a uint32 and saturates near 4 GB, so a
    // 6/8/12 GB card reports ~4095 MB — just under the CUDA threshold, which is
    // why a clearly CUDA-capable machine was being recommended CPU. Discard any
    // reading in that saturation band as unreliable…
    let mut vram_mb = gpu_val["VRAM"]
        .as_u64()
        .filter(|&b| b < 4_000_000_000)
        .map(|b| b / (1024 * 1024));
    // …and, for NVIDIA, prefer nvidia-smi's accurate figure when it's installed.
    if gpu_vendor.as_deref() == Some("NVIDIA") {
        if let Some(v) = nvidia_smi_vram_mb() {
            vram_mb = Some(v);
        }
    }

    let ram_mb = run_powershell(ps_ram)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);

    (gpu_name, gpu_vendor, vram_mb, ram_mb)
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Option<String> {
    let out = hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn query_hardware_macos() -> (Option<String>, Option<String>, Option<u64>, u64) {
    let sp = hidden_command("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    let val: serde_json::Value = serde_json::from_str(&sp).unwrap_or_default();
    let gpu_name = val["SPDisplaysDataType"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|g| g["_name"].as_str())
        .map(String::from);
    let vram_mb = val["SPDisplaysDataType"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|g| g["spdisplays_vram"].as_str())
        .and_then(|s| s.split_whitespace().next())
        .and_then(|n| n.parse::<u64>().ok());

    let ram_bytes = hidden_command("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u64>()
                .ok()
        })
        .unwrap_or(0);

    let gpu_vendor = gpu_name
        .as_deref()
        .map(extract_gpu_vendor)
        .map(String::from);
    (gpu_name, gpu_vendor, vram_mb, ram_bytes / (1024 * 1024))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn query_hardware_linux() -> (Option<String>, Option<String>, Option<u64>, u64) {
    let lspci = hidden_command("lspci")
        .args(["-mm", "-d", "::0300"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    let gpu_line = lspci.lines().next().map(String::from);
    let gpu_vendor = gpu_line
        .as_deref()
        .map(|l| {
            if l.contains("NVIDIA") {
                "NVIDIA"
            } else if l.contains("AMD") || l.contains("Advanced Micro Devices") {
                "AMD"
            } else if l.contains("Intel") {
                "Intel"
            } else {
                "Unknown"
            }
        })
        .map(String::from);

    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let ram_mb = meminfo
        .lines()
        .find(|l| l.starts_with("MemTotal:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|n| n.parse::<u64>().ok())
        .map(|kb| kb / 1024)
        .unwrap_or(0);

    // lspci doesn't report VRAM; query nvidia-smi for an accurate figure so the
    // CUDA recommendation has real data to gate on.
    let vram_mb = if gpu_vendor.as_deref() == Some("NVIDIA") {
        nvidia_smi_vram_mb()
    } else {
        None
    };

    (gpu_line, gpu_vendor, vram_mb, ram_mb)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- preset recommendation ----
    //
    // The real catalog has one preset, so exercising only that would prove nothing
    // about the ladder. These build a three-rung catalog and walk a machine up it.

    const LOW: PipelinePreset = PipelinePreset {
        id: "low",
        requires: catalog::Requirements {
            min_ram_mb: 4_096,
            min_vram_mb: None,
        },
        ..catalog::TESSERACT_QWEN
    };
    const MID: PipelinePreset = PipelinePreset {
        id: "mid",
        requires: catalog::Requirements {
            min_ram_mb: 16_384,
            min_vram_mb: None,
        },
        ..catalog::TESSERACT_QWEN
    };
    const HIGH: PipelinePreset = PipelinePreset {
        id: "high",
        requires: catalog::Requirements {
            min_ram_mb: 16_384,
            min_vram_mb: Some(8_192),
        },
        ..catalog::TESSERACT_QWEN
    };
    // Most capable first — the ordering `recommend_preset` reads as the ranking.
    const LADDER: &[PipelinePreset] = &[HIGH, MID, LOW];

    #[test]
    fn recommends_the_most_capable_preset_the_machine_meets() {
        assert_eq!(recommend_preset(32_768, Some(12_288), LADDER).id, "high");
        // Plenty of RAM, but the GPU is too small for the top rung.
        assert_eq!(recommend_preset(32_768, Some(4_096), LADDER).id, "mid");
        assert_eq!(recommend_preset(16_384, None, LADDER).id, "mid");
        assert_eq!(recommend_preset(8_192, None, LADDER).id, "low");
    }

    /// Unreadable VRAM must not qualify a machine for a VRAM-gated preset. This is the
    /// opposite of `recommend_backend`'s treatment of the same `None`, and the reason
    /// is the cost of being wrong: there it is some lost speed, here it is a
    /// multi-gigabyte download for a pipeline that then will not run.
    #[test]
    fn unknown_vram_does_not_qualify_for_a_vram_gated_preset() {
        assert_eq!(recommend_preset(32_768, None, LADDER).id, "mid");
    }

    /// A machine under every floor still has to be given something to install.
    #[test]
    fn a_machine_below_every_floor_gets_the_least_demanding_preset() {
        assert_eq!(recommend_preset(2_048, None, LADDER).id, "low");
    }

    /// A machine sold as "16 GB" reports ~16,300 MB, and an "8 GB" one ~7,900. A floor
    /// written as the nominal figure excludes every machine of that size, and does it
    /// silently — the preset is simply never offered and nothing says why. This walks
    /// real reported sizes past the real catalog.
    #[test]
    fn nominal_ram_sizes_actually_clear_the_catalog_floors() {
        // Reported totals from actual machines, not round powers of two.
        let eight_gb: u64 = 7_936;
        let sixteen_gb: u64 = 16_306;

        for p in catalog::PRESETS {
            if p.requires.min_vram_mb.is_some() {
                continue; // VRAM-gated presets are a separate question
            }
            match p.requires.min_ram_mb {
                floor if floor <= 8_192 => assert!(
                    eight_gb >= u64::from(floor),
                    "`{}` claims to run on 8 GB but demands {floor} MB, which no 8 GB machine reports",
                    p.id
                ),
                floor => assert!(
                    sixteen_gb >= u64::from(floor),
                    "`{}` demands {floor} MB, which no 16 GB machine reports",
                    p.id
                ),
            }
        }

        // And the end-to-end consequence: an 8 GB machine gets something, a 16 GB
        // machine gets the most capable preset the catalog has for it.
        assert!(catalog::preset(recommend_preset(eight_gb, None, catalog::PRESETS).id).is_some());
        let best = recommend_preset(sixteen_gb, None, catalog::PRESETS);
        assert_eq!(
            best.id,
            catalog::PRESETS[0].id,
            "a 16 GB machine must reach the top of the ladder"
        );
    }

    #[test]
    fn the_real_catalog_recommends_something_runnable_on_any_machine() {
        for (ram, vram) in [(2_048, None), (8_192, None), (65_536, Some(24_576))] {
            let p = recommend_preset(ram, vram, catalog::PRESETS);
            assert!(
                catalog::preset(p.id).is_some(),
                "{} is not in the catalog",
                p.id
            );
        }
    }

    #[test]
    fn availability_reports_every_preset_with_its_requirements() {
        let rows = preset_availability(8_192, None, LADDER);
        assert_eq!(rows.len(), 3);
        // Reported, not hidden: a user comparing options needs to see what their
        // machine rules out, and why.
        assert_eq!(rows.iter().filter(|r| r.supported).count(), 1);
        let high = rows.iter().find(|r| r.id == "high").unwrap();
        assert!(!high.supported);
        assert_eq!(high.min_vram_mb, Some(8_192));
        assert!(high.download_mb > 0, "the download size must be shown");
    }

    #[test]
    fn download_size_sums_every_model_the_preset_needs() {
        let expected: u32 = catalog::TESSERACT_QWEN
            .model_ids()
            .iter()
            .map(|id| catalog::model(id).unwrap().footprint.weights_mb)
            .sum();
        assert_eq!(download_mb(&catalog::TESSERACT_QWEN), expected);
        assert!(expected > 0);
    }

    #[test]
    fn recommend_backend_matrix() {
        // NVIDIA with ample VRAM -> cuda.
        assert_eq!(
            recommend_backend(Some("NVIDIA GeForce RTX 4070"), Some(8192)),
            "cuda"
        );
        // NVIDIA below the 4 GB threshold -> cpu.
        assert_eq!(recommend_backend(Some("NVIDIA"), Some(2048)), "cpu");
        // NVIDIA with unreliable (None) VRAM -> cuda, not a wrong CPU downgrade (CR:H3).
        assert_eq!(recommend_backend(Some("NVIDIA"), None), "cuda");
        // Apple -> metal regardless of VRAM.
        assert_eq!(recommend_backend(Some("Apple M3"), None), "metal");
        // Intel / unknown / no vendor -> cpu.
        assert_eq!(recommend_backend(Some("Intel Iris"), None), "cpu");
        assert_eq!(recommend_backend(None, Some(99999)), "cpu");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn recommend_backend_amd_is_rocm_on_linux() {
        assert_eq!(recommend_backend(Some("AMD Radeon"), Some(8192)), "rocm");
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn recommend_backend_amd_is_cpu_off_linux() {
        // ROCm only ships on the (future) Linux target; AMD elsewhere falls back to CPU.
        assert_eq!(recommend_backend(Some("AMD Radeon"), Some(8192)), "cpu");
    }

    #[test]
    fn extract_gpu_vendor_classifies_known_brands() {
        assert_eq!(extract_gpu_vendor("NVIDIA GeForce RTX 4070"), "NVIDIA");
        assert_eq!(extract_gpu_vendor("AMD Radeon RX 7900"), "AMD");
        assert_eq!(extract_gpu_vendor("Radeon Pro 5500M"), "AMD");
        assert_eq!(extract_gpu_vendor("Apple M3 Max"), "Apple");
        assert_eq!(extract_gpu_vendor("Intel UHD Graphics 630"), "Intel");
        assert_eq!(extract_gpu_vendor("Some Other GPU"), "Unknown");
    }

    #[test]
    fn current_os_matches_compilation_target() {
        let os = current_os();
        if cfg!(target_os = "windows") {
            assert_eq!(os, "windows");
        } else if cfg!(target_os = "macos") {
            assert_eq!(os, "macos");
        } else {
            assert_eq!(os, "linux");
        }
    }

    #[test]
    fn available_backends_are_platform_appropriate() {
        let b = available_backends();
        assert!(!b.is_empty());
        if cfg!(target_os = "macos") {
            // No CPU/CUDA split on macOS — only the Metal build ships.
            assert_eq!(b, vec!["metal".to_string()]);
            assert!(!b.contains(&"cuda".to_string()));
        } else if cfg!(target_os = "windows") {
            assert!(b.contains(&"cuda".to_string()));
            assert!(b.contains(&"cpu".to_string()));
            assert!(!b.contains(&"metal".to_string()));
        }
    }

    #[test]
    fn parse_nvidia_smi_reads_first_line_mb() {
        assert_eq!(parse_nvidia_smi("8192\n"), Some(8192));
        assert_eq!(parse_nvidia_smi("  12288  \n4096\n"), Some(12288));
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("not a number"), None);
    }

    #[test]
    fn probe_hardware_does_not_panic() {
        // Smoke: probing real hardware must always return a struct, never panic,
        // even with no GPU / tools absent.
        let hw = probe_hardware();
        assert!(!hw.recommended_backend.is_empty());
        assert!(!hw.os.is_empty());
    }
}
