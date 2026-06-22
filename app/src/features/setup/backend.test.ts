import { describe, it, expect } from 'vitest';
import { backendWarning, BACKEND_LABEL, BACKEND_DESCRIPTION } from './backend';
import type { Backend } from './types';
import { hardwareInfo as hw } from '../../test/fixtures';

describe('backendWarning — cuda', () => {
    it('warns when no NVIDIA GPU is present', () => {
        const w = backendWarning('cuda', hw({ gpu_vendor: 'AMD', gpu_name: 'Radeon RX' }));
        expect(w).toMatch(/NVIDIA/);
        expect(w).toMatch(/Radeon RX/);
    });

    it('warns (in GB) when NVIDIA VRAM is below 4 GB', () => {
        const w = backendWarning('cuda', hw({ gpu_vendor: 'NVIDIA', vram_mb: 2048 }));
        expect(w).toMatch(/2\.0 GB/);
        expect(w).toMatch(/4 GB/);
    });

    it('is clean for NVIDIA with >= 4 GB VRAM', () => {
        expect(backendWarning('cuda', hw({ gpu_vendor: 'NVIDIA', vram_mb: 8192 }))).toBeNull();
    });

    it('is clean for NVIDIA with unknown (null) VRAM', () => {
        expect(backendWarning('cuda', hw({ gpu_vendor: 'NVIDIA', vram_mb: null }))).toBeNull();
    });
});

describe('backendWarning — rocm', () => {
    it('warns when no AMD GPU is present', () => {
        expect(backendWarning('rocm', hw({ gpu_vendor: 'NVIDIA' }))).toMatch(/AMD/);
    });
    it('is clean for an AMD GPU', () => {
        expect(backendWarning('rocm', hw({ gpu_vendor: 'AMD' }))).toBeNull();
    });
});

describe('backendWarning — metal & cpu always fit', () => {
    it('metal never warns', () => {
        expect(backendWarning('metal', hw({ gpu_vendor: 'Apple', os: 'macos' }))).toBeNull();
    });
    it('cpu never warns', () => {
        expect(backendWarning('cpu', hw({ gpu_vendor: 'NVIDIA' }))).toBeNull();
        expect(backendWarning('cpu', hw({}))).toBeNull();
    });
});

describe('backend metadata completeness', () => {
    it('every Backend has a label and description', () => {
        const backends: Backend[] = ['cpu', 'cuda', 'rocm', 'metal'];
        for (const b of backends) {
            expect(BACKEND_LABEL[b]).toBeTruthy();
            expect(BACKEND_DESCRIPTION[b]).toBeTruthy();
        }
    });
});
