export type SetupStep = 'welcome' | 'config' | 'download' | 'verify' | 'complete';
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
}

export interface AssetProgress {
    status: 'pending' | 'downloading' | 'extracting' | 'done' | 'skipped' | 'error';
    bytes_received: number;
    total_bytes: number | null;
    error?: string;
}

export interface SetupPaths {
    llama_server: string;
    model_path: string;
    mmproj_path: string;
}
