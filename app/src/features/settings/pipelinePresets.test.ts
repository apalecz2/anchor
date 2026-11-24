import { describe, it, expect } from 'vitest';
import { formatRamRequirement, presetCaveat, type PresetOption } from './pipelinePresets';

const preset = (over: Partial<PresetOption> = {}): PresetOption => ({
    id: 'tesseract-qwen3.5-4b',
    label: 'Fast',
    description: 'Tesseract reads the page, Qwen builds the table.',
    download_mb: 3255,
    min_ram_mb: 7500,
    min_vram_mb: null,
    supported: true,
    installed: true,
    selected: true,
    ...over,
});

describe('formatRamRequirement', () => {
    it('reports catalog megabytes as the gigabytes users think in', () => {
        expect(formatRamRequirement(7500)).toBe('8 GB RAM');
        expect(formatRamRequirement(15000)).toBe('15 GB RAM');
    });
});

describe('presetCaveat', () => {
    it('says nothing about a preset that is ready to use', () => {
        // A row with no warning on it should look like it has no warning.
        expect(presetCaveat(preset())).toBeNull();
    });

    it('distinguishes "this machine cannot" from "not downloaded yet"', () => {
        // Two different problems: one the user can act on, one they cannot. Collapsing
        // them into a single "unavailable" would tell them nothing about which is which.
        const tooSmall = presetCaveat(preset({ supported: false, min_ram_mb: 15000 }));
        expect(tooSmall).toMatch(/15 GB RAM/);
        expect(tooSmall).toMatch(/reports less/);

        const notInstalled = presetCaveat(preset({ installed: false }));
        expect(notInstalled).toMatch(/returns to setup/);
    });

    it('mentions video memory only when the preset actually demands it', () => {
        expect(presetCaveat(preset({ supported: false, min_vram_mb: 8000 })))
            .toMatch(/video memory/);
        expect(presetCaveat(preset({ supported: false, min_vram_mb: null })))
            .not.toMatch(/video memory/);
    });

    it('leads with the hardware limit when a preset is both unsupported and missing', () => {
        // Telling someone to download something their machine cannot run is worse than
        // useless — it costs them gigabytes before they find out.
        expect(presetCaveat(preset({ supported: false, installed: false })))
            .toMatch(/reports less/);
    });
});
