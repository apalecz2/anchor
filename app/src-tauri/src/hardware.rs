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
}

#[tauri::command]
pub fn detect_hardware() -> HardwareInfo {
    let (gpu_name, gpu_vendor, vram_mb, ram_mb) = query_hardware();
    let recommended_backend = recommend_backend(gpu_vendor.as_deref(), vram_mb);
    HardwareInfo { gpu_name, gpu_vendor, vram_mb, ram_mb, recommended_backend }
}

fn recommend_backend(vendor: Option<&str>, vram_mb: Option<u64>) -> String {
    let v = match vendor { Some(s) => s, None => return "cpu".into() };
    if v.contains("NVIDIA") && vram_mb.unwrap_or(0) >= 4096 {
        return "cuda".into();
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

fn extract_gpu_vendor(name: &str) -> &'static str {
    let u = name.to_uppercase();
    if u.contains("NVIDIA") { "NVIDIA" }
    else if u.contains("AMD") || u.contains("RADEON") { "AMD" }
    else if u.contains("APPLE") { "Apple" }
    else if u.contains("INTEL") { "Intel" }
    else { "Unknown" }
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
    let vram_mb = gpu_val["VRAM"].as_u64().map(|b| b / (1024 * 1024));
    let gpu_vendor = gpu_name.as_deref().map(extract_gpu_vendor).map(String::from);

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
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
        .unwrap_or(0);

    let gpu_vendor = gpu_name.as_deref().map(extract_gpu_vendor).map(String::from);
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
    let gpu_vendor = gpu_line.as_deref().map(|l| {
        if l.contains("NVIDIA") { "NVIDIA" }
        else if l.contains("AMD") || l.contains("Advanced Micro Devices") { "AMD" }
        else if l.contains("Intel") { "Intel" }
        else { "Unknown" }
    }).map(String::from);

    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let ram_mb = meminfo.lines()
        .find(|l| l.starts_with("MemTotal:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|n| n.parse::<u64>().ok())
        .map(|kb| kb / 1024)
        .unwrap_or(0);

    (gpu_line, gpu_vendor, None, ram_mb)
}
