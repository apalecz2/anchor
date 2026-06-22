import { vi } from 'vitest';

// Small DOM/test-double helpers shared across component specs. (Tauri command
// mocking is done per-spec with `vi.mock('@tauri-apps/api/core', …)`, which is
// more flexible than a shared IPC transport mock and keeps each spec self-contained.)

/** Replace navigator.clipboard.writeText with a spy and return it. */
export const mockClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    return writeText;
};

/** Build a streaming `fetch` Response from raw SSE text chunks (for llama SSE tests). */
export const sseResponse = (chunks: string[], { status = 200 } = {}): Response => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(enc.encode(c));
            controller.close();
        },
    });
    return new Response(stream, { status });
};
