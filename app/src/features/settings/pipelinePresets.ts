import { invoke } from '@tauri-apps/api/core';

/**
 * One pipeline the user can choose between.
 *
 * Mirrors `PresetOption` in `src-tauri/src/setup.rs`. `supported` and `installed` are
 * different questions and both have to be shown: a preset this machine cannot meet is
 * a hardware limit, while one that is simply not downloaded yet is a trip back through
 * setup. Conflating them into a single "unavailable" would tell the user nothing about
 * which of the two they can do something about.
 */
export type PresetOption = {
    id: string;
    label: string;
    description: string;
    download_mb: number;
    min_ram_mb: number;
    min_vram_mb: number | null;
    supported: boolean;
    installed: boolean;
    selected: boolean;
};

export const listPipelinePresets = (): Promise<PresetOption[]> =>
    invoke<PresetOption[]>('list_pipeline_presets');

export const persistPreset = (presetId: string): Promise<void> =>
    invoke('persist_preset', { presetId });

/** Memory figures in the catalog are megabytes; users think in gigabytes. */
export const formatRamRequirement = (mb: number): string => `${Math.round(mb / 1000)} GB RAM`;

/**
 * What choosing this preset would cost, or why it cannot be chosen.
 *
 * Returns `null` when there is nothing the user needs to know — which is the common
 * case, and a row with no warning on it should look like it has no warning.
 */
export const presetCaveat = (preset: PresetOption): string | null => {
    if (!preset.supported) {
        const vram = preset.min_vram_mb ? ` and ${formatRamRequirement(preset.min_vram_mb)} of video memory` : '';
        return `Needs about ${formatRamRequirement(preset.min_ram_mb)}${vram}. This machine reports less, so it would run slowly or fail to load.`;
    }
    if (!preset.installed) {
        return 'Not downloaded yet — choosing this returns to setup to fetch what it needs.';
    }
    return null;
};
