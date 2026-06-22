import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
    extractTableFromImage,
    checkLlamaServerHealth,
    startLlamaServer,
    stopLlamaServer,
} from './llamaClient';
import { sseResponse } from '../../test/helpers';

const PORT = 5599;

beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    // Default: a running server on PORT; stop is a no-op.
    invoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_llama_server_port') return Promise.resolve(PORT);
        if (cmd === 'stop_llama_server') return Promise.resolve(undefined);
        return Promise.resolve(undefined);
    });
});

afterEach(async () => {
    // Clears the module-level cached port so each test re-resolves it.
    await stopLlamaServer();
    vi.restoreAllMocks();
});

describe('extractTableFromImage — SSE parsing', () => {
    it('iterates multi-token logprobs, records null logprobs, accumulates offsets, captures finish_reason', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            sseResponse([
                'data: {"choices":[{"delta":{},"logprobs":{"content":[{"token":"He","logprob":-0.1},{"token":"llo","logprob":null}]}}]}\n\n',
                'data: {"choices":[{"finish_reason":"length","delta":{}}]}\n\n',
                'data: [DONE]\n\n',
            ]),
        );

        const onDelta = vi.fn();
        const res = await extractTableFromImage({
            messages: [{ role: 'user', content: 'x' }],
            maxTokens: 100,
            onContentDelta: onDelta,
        });

        expect(res.content).toBe('Hello');
        expect(res.finishReason).toBe('length');
        expect(res.logprobs).toHaveLength(2);
        expect(res.logprobs[0]).toMatchObject({ token: 'He', logprob: -0.1, charOffset: 0 });
        expect(res.logprobs[1]).toMatchObject({ token: 'llo', logprob: null, charOffset: 2 });
        expect(onDelta).toHaveBeenLastCalledWith('Hello');
        fetchSpy.mockRestore();
    });

    it('warns exactly once when content has no usable logprobs (F7)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            sseResponse([
                'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
                'data: [DONE]\n\n',
            ]),
        );
        const res = await extractTableFromImage({
            messages: [{ role: 'user', content: 'x' }],
            maxTokens: 10,
            onContentDelta: vi.fn(),
        });
        expect(res.content).toBe('hi');
        expect(res.logprobs[0].logprob).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('skips blank lines and [DONE]', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            sseResponse([
                '\n',
                'data: [DONE]\n\n',
                'data: {"choices":[{"delta":{},"logprobs":{"content":[{"token":"A","logprob":-0.2}]}}]}\n\n',
            ]),
        );
        const res = await extractTableFromImage({
            messages: [{ role: 'user', content: 'x' }],
            maxTokens: 10,
            onContentDelta: vi.fn(),
        });
        expect(res.content).toBe('A');
    });

    it('throws on a non-OK HTTP status', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(['x'], { status: 500 }));
        await expect(
            extractTableFromImage({ messages: [], maxTokens: 10, onContentDelta: vi.fn() }),
        ).rejects.toThrow(/HTTP 500/);
    });

    it('throws when no server port is known', async () => {
        invoke.mockImplementation((cmd: string) =>
            cmd === 'get_llama_server_port' ? Promise.resolve(null) : Promise.resolve(undefined),
        );
        await expect(
            extractTableFromImage({ messages: [], maxTokens: 10, onContentDelta: vi.fn() }),
        ).rejects.toThrow(/not running/);
    });
});

describe('checkLlamaServerHealth (M8)', () => {
    it('is true only on a 200 with body {"status":"ok"}', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
        );
        await expect(checkLlamaServerHealth()).resolves.toBe(true);
    });

    it('is false on a 200 with a non-llama body (impostor on the port)', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ hello: 'world' }), { status: 200 }),
        );
        await expect(checkLlamaServerHealth()).resolves.toBe(false);
    });

    it('is false on a non-200', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
        await expect(checkLlamaServerHealth()).resolves.toBe(false);
    });

    it('is false when there is no server port', async () => {
        invoke.mockImplementation((cmd: string) =>
            cmd === 'get_llama_server_port' ? Promise.resolve(null) : Promise.resolve(undefined),
        );
        await expect(checkLlamaServerHealth()).resolves.toBe(false);
    });
});

describe('startLlamaServer', () => {
    it('falls back to get_setup_paths when settings paths are empty (F5) and never passes a binary path (M7)', async () => {
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_setup_paths')
                return Promise.resolve({ model_path: '/a/model.gguf', mmproj_path: '/a/mmproj.gguf' });
            if (cmd === 'start_llama_server') return Promise.resolve({ pid: 1234, port: PORT });
            return Promise.resolve(undefined);
        });

        const pid = await startLlamaServer();
        expect(pid).toBe(1234);

        const startCall = invoke.mock.calls.find(c => c[0] === 'start_llama_server');
        expect(startCall![1]).toEqual({
            modelPath: '/a/model.gguf',
            mmprojPath: '/a/mmproj.gguf',
            backend: 'cpu',
        });
        // The frontend never supplies a server binary path — resolved in Rust (M7).
        expect(Object.keys(startCall![1] as object)).not.toContain('serverPath');
    });

    it('throws when paths cannot be resolved even after the fallback', async () => {
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_setup_paths') return Promise.resolve({ model_path: '', mmproj_path: '' });
            return Promise.resolve(undefined);
        });
        await expect(startLlamaServer()).rejects.toThrow(/setup wizard/);
    });

    it('rethrows a spawn failure', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        localStorage.setItem('model_path', '/m.gguf');
        localStorage.setItem('mmproj_path', '/mm.gguf');
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'start_llama_server') return Promise.reject(new Error('spawn EACCES'));
            return Promise.resolve(undefined);
        });
        await expect(startLlamaServer()).rejects.toThrow(/spawn EACCES/);
    });
});
