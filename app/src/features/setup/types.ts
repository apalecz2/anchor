export type SetupStep = 'welcome' | 'terms' | 'config' | 'install' | 'complete';
/** Why the consent step is being shown, which decides what TermsStep may truthfully
 *  promise about downloads: only `first-install` runs precede any download.
 *  `terms-updated` = assets installed, an older EULA version was accepted;
 *  `reconsent`     = assets installed, no acceptance on record (e.g. cleared storage). */
export type ConsentContext = 'first-install' | 'terms-updated' | 'reconsent';
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
    /** Id of the pipeline preset this machine should run — the wizard pre-selects it.
     *  Chosen by `hardware.rs::recommend_preset` from RAM and VRAM, which is what the
     *  probe collected `ram_mb` for all along. */
    recommended_preset: string;
    /** Every catalog preset with whether this machine meets its requirements.
     *  Unsupported ones are listed too, so the picker can show what the hardware
     *  rules out instead of silently hiding the option. */
    presets: PresetAvailability[];
}

export interface PresetAvailability {
    id: string;
    label: string;
    description: string;
    /** Total model weights this preset downloads, in MB. */
    download_mb: number;
    min_ram_mb: number;
    min_vram_mb: number | null;
    supported: boolean;
}

export interface SetupConfig {
    backend: Backend;
    /** Pipeline preset to install. Absent means "whatever the backend implies",
     *  i.e. the catalog default — the shape every install had before presets. */
    presetId?: string;
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

// No 'error' state: a failure ends the install outright and the wizard swaps the
// whole step for its error screen, so a per-asset error status had nowhere to be
// seen. The failing component is named in the message that screen shows instead
// (see DownloadStep's `describeAssetFailure`).
export interface AssetProgress {
    status: 'pending' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'skipped';
    bytes_received: number;
    total_bytes: number | null;
}

export interface SetupPaths {
    llama_server: string;
    model_path: string;
    mmproj_path: string;
    /** Backend last persisted by the wizard (to AppData), or null if never saved.
     *  Lets a wizard-skipping launch restore the GPU choice instead of defaulting
     *  to cpu — see useSetupCheck auto-heal. */
    hardware_backend: Backend | null;
    /** Pipeline preset last persisted by the wizard, or null if never saved. Null is
     *  "never chosen" (an install predating presets), not "the default" — the backend
     *  falls back to the catalog default on its own, so this stays honest about
     *  whether the user actually picked. */
    pipeline_preset: string | null;
}
