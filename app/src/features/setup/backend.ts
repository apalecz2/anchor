import type { Backend, HardwareInfo } from './types';

export const BACKEND_LABEL: Record<Backend, string> = {
    cuda:  'CUDA (NVIDIA GPU)',
    rocm:  'ROCm (AMD GPU)',
    metal: 'Metal (Apple Silicon)',
    cpu:   'CPU only',
};

export const BACKEND_DESCRIPTION: Record<Backend, string> = {
    cuda:  'NVIDIA GPU acceleration. Fastest option on a CUDA-capable card with 4 GB+ VRAM.',
    rocm:  'AMD GPU acceleration on Linux.',
    metal: 'Apple Silicon GPU acceleration.',
    cpu:   'Works on any machine. Slower, but needs no GPU.',
};

/**
 * Why a backend may not suit the detected hardware. Returns null when the choice
 * is a good match. The custom installer surfaces this as a warning but still lets
 * the user proceed — the GPU build simply falls back to CPU at runtime if it
 * can't initialise, and the choice can be changed by re-running setup.
 */
export function backendWarning(backend: Backend, hw: HardwareInfo): string | null {
    const vendor = hw.gpu_vendor ?? '';
    switch (backend) {
        case 'cuda':
            if (vendor !== 'NVIDIA') {
                return `No NVIDIA GPU was detected (found ${hw.gpu_name ?? 'no GPU'}). The CUDA build needs an NVIDIA card to accelerate — it will fall back to CPU speed.`;
            }
            if (hw.vram_mb != null && hw.vram_mb < 4096) {
                return `Your GPU reports ${(hw.vram_mb / 1024).toFixed(1)} GB of VRAM, below the 4 GB recommended for CUDA. It may run out of memory on larger documents.`;
            }
            return null;
        case 'rocm':
            if (vendor !== 'AMD') {
                return `No AMD GPU was detected (found ${hw.gpu_name ?? 'no GPU'}). The ROCm build needs an AMD card.`;
            }
            return null;
        case 'metal':
            return null; // the macOS build is the only one shipped; always fits
        case 'cpu':
            return null; // always safe
    }
}
