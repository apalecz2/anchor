import { describe, it, expect, beforeEach } from 'vitest';
import {
    readSetting,
    writeSetting,
    hasSetting,
    THEMES,
    HARDWARE_BACKENDS,
} from './settings';

// Minimal in-memory localStorage so this stays a Tier-1 node test (no jsdom).
beforeEach(() => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
            return store.size;
        },
    } as Storage;
});

describe('readSetting / writeSetting round-trip', () => {
    it('returns the default when a key was never written', () => {
        expect(readSetting('theme')).toBe('dark');
        expect(readSetting('hardwareBackend')).toBe('cpu');
        expect(readSetting('ocrLanguage')).toBe('eng');
        expect(readSetting('modelPath')).toBe('');
    });

    it('passes a valid stored value through', () => {
        writeSetting('theme', 'light');
        expect(readSetting('theme')).toBe('light');
        writeSetting('hardwareBackend', 'cuda');
        expect(readSetting('hardwareBackend')).toBe('cuda');
    });

    it('passes free-text keys through unchanged', () => {
        writeSetting('modelPath', '/some/path/model.gguf');
        expect(readSetting('modelPath')).toBe('/some/path/model.gguf');
    });
});

describe('VALIDATORS — corrupt/hand-edited values fall back to default (L7)', () => {
    it('rejects an invalid theme and returns the default', () => {
        localStorage.setItem('theme', 'neon');
        expect(readSetting('theme')).toBe('dark');
    });

    it('rejects an invalid hardwareBackend and returns the default', () => {
        localStorage.setItem('hardware_backend', 'quantum');
        expect(readSetting('hardwareBackend')).toBe('cpu');
    });

    it('accepts every declared theme / backend', () => {
        for (const t of THEMES) {
            writeSetting('theme', t);
            expect(readSetting('theme')).toBe(t);
        }
        for (const b of HARDWARE_BACKENDS) {
            writeSetting('hardwareBackend', b);
            expect(readSetting('hardwareBackend')).toBe(b);
        }
    });
});

describe('hasSetting — distinguishes "never set" from "set to default"', () => {
    it('is false before a write and true after, even when the value equals the default', () => {
        expect(hasSetting('hardwareBackend')).toBe(false);
        writeSetting('hardwareBackend', 'cpu'); // equals DEFAULTS.hardwareBackend
        expect(hasSetting('hardwareBackend')).toBe(true);
    });
});

describe('type/validator single-source-of-truth', () => {
    it('keeps the validator allow-list in sync with the union arrays', () => {
        // Every member the type allows must validate; nothing else should.
        expect(THEMES).toEqual(expect.arrayContaining(['light', 'dark']));
        expect(HARDWARE_BACKENDS).toEqual(
            expect.arrayContaining(['cpu', 'cuda', 'rocm', 'metal']),
        );
        localStorage.setItem('theme', THEMES[0]);
        expect(readSetting('theme')).toBe(THEMES[0]);
    });
});
