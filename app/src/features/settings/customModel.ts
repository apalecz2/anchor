import { invoke } from '@tauri-apps/api/core';

/**
 * A GGUF the user chose themselves, as the backend records it.
 *
 * Mirrors `CustomModel` in `src-tauri/src/pipeline/custom.rs`. Note what is *not*
 * here: no URL, and no projector. The backend accepts only a path to a file already
 * on this computer, and the custom pipeline is text-only because nothing about an
 * arbitrary checkpoint says whether it can read an image.
 */
export type CustomModel = {
    weightsPath: string;
    ctx: number;
    weightsBytes: number;
};

/** Context sizes the backend will accept; mirrored here so the input can say so. */
export const MIN_CUSTOM_CTX = 2048;
export const MAX_CUSTOM_CTX = 131072;

export const getCustomModel = (): Promise<CustomModel | null> =>
    invoke<CustomModel | null>('get_custom_model');

/**
 * Register a GGUF.
 *
 * Validation lives entirely in Rust — extension, existence, and the four-byte `GGUF`
 * header — so this deliberately does no checking of its own. A second, laxer copy of
 * the rules in the webview would be the one people read and the strict one would be
 * the surprise; and the webview's copy is the one an attacker skips anyway.
 */
export const setCustomModel = (weightsPath: string, ctx: number): Promise<CustomModel> =>
    invoke<CustomModel>('set_custom_model', { weightsPath, ctx });

/** Forget Anchor's record of the model. The user's file is never touched. */
export const clearCustomModel = (): Promise<void> => invoke('clear_custom_model');

/** The file's own name, for display — the full path is too long for a settings row. */
export const fileNameOf = (path: string): string =>
    path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Bytes as a short human string. Model files are gigabytes, so GB leads. */
export const formatModelSize = (bytes: number): string => {
    if (bytes <= 0) return 'unknown size';
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
};
