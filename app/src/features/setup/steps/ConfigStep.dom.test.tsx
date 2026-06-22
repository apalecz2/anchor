import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfigStep from './ConfigStep';
import type { HardwareInfo } from '../types';
import { hardwareInfo } from '../../../test/fixtures';

// This step's tests assume a typical NVIDIA box; layer that over the shared default.
const hw = (over: Partial<HardwareInfo> = {}): HardwareInfo =>
    hardwareInfo({
        gpu_name: 'NVIDIA RTX 4070',
        gpu_vendor: 'NVIDIA',
        vram_mb: 8192,
        ram_mb: 16384,
        recommended_backend: 'cuda',
        available_backends: ['cuda', 'cpu'],
        ...over,
    });

describe('ConfigStep', () => {
    it('renders only the platform-available backends (no Metal on Windows, M6)', () => {
        render(<ConfigStep hardware={hw()} onNext={vi.fn()} onBack={vi.fn()} />);
        expect(screen.getByText('CUDA (NVIDIA GPU)')).toBeInTheDocument();
        expect(screen.getByText('CPU only')).toBeInTheDocument();
        expect(screen.queryByText('Metal (Apple Silicon)')).not.toBeInTheDocument();
    });

    it('pre-selects the recommended backend and starts download with it', () => {
        const onNext = vi.fn();
        render(<ConfigStep hardware={hw()} onNext={onNext} onBack={vi.fn()} />);
        expect(screen.getByText('Recommended')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Start download/ }));
        expect(onNext).toHaveBeenCalledWith({ backend: 'cuda' });
    });

    it('falls back to the first option when the recommendation is not available', () => {
        const onNext = vi.fn();
        // Recommend cpu but only metal is on offer (macOS-style mismatch).
        render(
            <ConfigStep
                hardware={hw({ recommended_backend: 'cpu', available_backends: ['metal'], os: 'macos' })}
                onNext={onNext}
                onBack={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: /Start download/ }));
        expect(onNext).toHaveBeenCalledWith({ backend: 'metal' });
    });

    it('shows a warning when the selected backend does not suit the hardware', () => {
        // AMD GPU, recommend cpu; selecting CUDA should warn.
        render(
            <ConfigStep
                hardware={hw({ gpu_vendor: 'AMD', gpu_name: 'Radeon RX', recommended_backend: 'cpu' })}
                onNext={vi.fn()}
                onBack={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByText('CUDA (NVIDIA GPU)'));
        expect(screen.getByText(/No NVIDIA GPU was detected/)).toBeInTheDocument();
    });

    it('fires onBack', () => {
        const onBack = vi.fn();
        render(<ConfigStep hardware={hw()} onNext={vi.fn()} onBack={onBack} />);
        fireEvent.click(screen.getByRole('button', { name: /Back/ }));
        expect(onBack).toHaveBeenCalled();
    });
});
