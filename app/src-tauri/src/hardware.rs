//! Hardware detection for backend selection.
//!
//! Probes the GPU (name/vendor/VRAM) and total RAM per platform and recommends a
//! llama.cpp backend (cuda / rocm / metal / cpu). All probing is best-effort:
//! failures degrade to "cpu" rather than erroring.

use std::process::Command;

use serde::Serialize;

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
}

#[tauri::command]
pub fn detect_hardware() -> HardwareInfo {
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
    }
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

fn current_os() -> &'static str {
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
    let out = Command::new("nvidia-smi")
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
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn query_hardware_macos() -> (Option<String>, Option<String>, Option<u64>, u64) {
    let sp = Command::new("system_profiler")
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

    let ram_bytes = Command::new("sysctl")
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
    let lspci = Command::new("lspci")
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
    fn detect_hardware_does_not_panic() {
        // Smoke: probing real hardware must always return a struct, never panic,
        // even with no GPU / tools absent.
        let hw = detect_hardware();
        assert!(!hw.recommended_backend.is_empty());
        assert!(!hw.os.is_empty());
    }
}
