export type SetupStep = 'welcome' | 'config' | 'install' | 'complete';
export type SetupMode = 'automatic' | 'custom';
export type Backend = 'cpu' | 'cuda' | 'rocm' | 'metal';
export type OS = 'windows' | 'macos' | 'linux';

export interface HardwareInfo {
    gpu_name: string | null;
    gpu_vendor: string | null;
    vram_mb: number | null;
    ram_mb: number;
    recommended_backend: Backend;
    os: OS;
    available_backends: Backend[];
}

export interface SetupConfig {
    backend: Backend;
}

export interface AssetManifestEntry {
    asset_id: string;
    label: string;
    size_bytes: number;
    dest_path: string;
    sha256: string;
    url_primary: string;
    url_fallback: string | null;
    extract_to_dir: string | null;
    flatten_marker: string | null;
    installed: boolean;
    /** Human-readable upstream version this asset is pinned to (audit; design F7).
     *  null where no stable version string applies (e.g. PDFium, Tesseract). */
    version: string | null;
}

export interface AssetProgress {
    status: 'pending' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'skipped' | 'error';
    bytes_received: number;
    total_bytes: number | null;
    error?: string;
}

export interface SetupPaths {
    llama_server: string;
    model_path: string;
    mmproj_path: string;
    /** Backend last persisted by the wizard (to AppData), or null if never saved.
     *  Lets a wizard-skipping launch restore the GPU choice instead of defaulting
     *  to cpu — see useSetupCheck auto-heal. */
    hardware_backend: Backend | null;
}
