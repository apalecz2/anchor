import { describe, it, expect } from 'vitest';
import { fileNameOf, formatModelSize, MIN_CUSTOM_CTX, MAX_CUSTOM_CTX } from './customModel';

describe('fileNameOf', () => {
    it('takes the last segment of a Windows or POSIX path', () => {
        expect(fileNameOf('C:\\Users\\a\\models\\Qwen3.5-4B-Q4_K_M.gguf')).toBe('Qwen3.5-4B-Q4_K_M.gguf');
        expect(fileNameOf('/home/a/models/model.gguf')).toBe('model.gguf');
    });

    it('survives trailing separators and a bare filename', () => {
        expect(fileNameOf('/home/a/models/model.gguf/')).toBe('model.gguf');
        expect(fileNameOf('model.gguf')).toBe('model.gguf');
    });

    it('falls back to the input rather than returning empty', () => {
        // A settings row showing nothing where a path should be reads as a bug; the
        // raw value at least tells the user what Anchor recorded.
        expect(fileNameOf('')).toBe('');
        expect(fileNameOf('///')).toBe('///');
    });
});

describe('formatModelSize', () => {
    it('leads with GB, because model files are gigabytes', () => {
        expect(formatModelSize(2_740_937_888)).toBe('2.7 GB');
        expect(formatModelSize(672_423_616)).toBe('672 MB');
        expect(formatModelSize(15_000)).toBe('15 KB');
    });

    it('says so rather than showing "0 bytes" when the size is unknown', () => {
        // A registration written before sizes were recorded stores 0. Rendering that
        // as a size would claim the file is empty.
        expect(formatModelSize(0)).toBe('unknown size');
        expect(formatModelSize(-1)).toBe('unknown size');
    });
});

describe('context bounds', () => {
    it('mirrors the range the backend enforces', () => {
        // Duplicated deliberately so the number input can advertise the limit, but the
        // backend is what rejects — these exist to stop the UI offering what Rust will
        // refuse, not to do the checking.
        expect(MIN_CUSTOM_CTX).toBe(2048);
        expect(MAX_CUSTOM_CTX).toBe(131072);
        expect(MIN_CUSTOM_CTX).toBeLessThan(MAX_CUSTOM_CTX);
    });
});
