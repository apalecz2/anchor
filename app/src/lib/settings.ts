export type HardwareMode = 'low-end' | 'high-end';
export type Theme = 'light' | 'dark';
export type HardwareBackend = 'cpu' | 'cuda' | 'rocm' | 'metal';

interface SettingsSchema {
    theme: Theme;
    hardwareMode: HardwareMode;
    modelPath: string;
    mmprojPath: string;
    ocrLanguage: string;
    llamaServerPath: string;
    hardwareBackend: HardwareBackend;
}

// 'theme' key is shared with AppLayout.tsx's dark-mode toggle
const STORAGE_KEYS: Record<keyof SettingsSchema, string> = {
    theme: 'theme',
    hardwareMode: 'hardware_mode',
    modelPath: 'model_path',
    mmprojPath: 'mmproj_path',
    ocrLanguage: 'ocr_language',
    llamaServerPath: 'llama_server_path',
    hardwareBackend: 'hardware_backend',
};

const DEFAULTS: SettingsSchema = {
    theme: 'dark',
    hardwareMode: 'high-end',
    modelPath: '',
    mmprojPath: '',
    ocrLanguage: 'eng',
    llamaServerPath: '',
    hardwareBackend: 'cpu',
};

export function readSetting<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
    const value = localStorage.getItem(STORAGE_KEYS[key]);
    return (value !== null ? value : DEFAULTS[key]) as SettingsSchema[K];
}

export function writeSetting<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): void {
    localStorage.setItem(STORAGE_KEYS[key], value);
}
