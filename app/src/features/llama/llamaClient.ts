import { invoke } from "@tauri-apps/api/core";
import { readSetting } from "../../lib/settings";

import type { ChatMessage, TokenLogprob } from "../extraction/types";

type ChatCompletionContentPart =
    | {
        type: "text";
        text: string;
    }
    | {
        type: "image_url";
        image_url: {
            url: string;
        };
    };

type ChatCompletionMessage = {
    role: "user" | "assistant" | "system";
    content: string | ChatCompletionContentPart[];
};

type ChatCompletionRequestBody = {
    messages: ChatCompletionMessage[];
    max_tokens: number;
    temperature: number;
    top_p: number;
    top_k: number;
    presence_penalty: number;
    stream: true;
    stop: string[];
    // Qwen3.5-specific: disable <think> block so the model outputs directly
    chat_template_kwargs: { enable_thinking: boolean };
};

type StreamChatCompletionOptions = {
    messages: ChatCompletionMessage[];
    onThinkingDelta: (content: string) => void;
    onContentDelta: (content: string) => void;
    onThinkingEnd: () => void;
    signal?: AbortSignal;
};

let llamaServerStartPromise: Promise<number | null> | null = null;

// The server binds a fresh ephemeral port each start (chosen in Rust, never a
// hardcoded 8080), so every request must target the port we were handed rather than
// a fixed one. Cached here and refreshed from the backend on demand; cleared on stop.
let cachedPort: number | null = null;

const resolveServerPort = async (): Promise<number | null> => {
    if (cachedPort !== null) return cachedPort;
    try {
        cachedPort = (await invoke<number | null>("get_llama_server_port")) ?? null;
    } catch {
        cachedPort = null;
    }
    return cachedPort;
};

/** Base URL of the running server, or null if no server/port is known. */
const serverBaseUrl = async (): Promise<string | null> => {
    const port = await resolveServerPort();
    return port === null ? null : `http://127.0.0.1:${port}`;
};

/** Process-liveness as reported by Rust: "running" | "exited" | "stopped". Lets the
 *  startup poll fail fast when the spawned server crashes (e.g. bad GGUF / OOM). */
export const getLlamaServerStatus = async (): Promise<string> => {
    try {
        return await invoke<string>("llama_server_status");
    } catch {
        return "stopped";
    }
};

// buildChatCompletionMessages + streamChatCompletion (below) form the conversational
// chat path. No UI calls them yet — they are intentionally retained for the planned
// chat feature (design §8), not dead code. Table extraction uses extractTableFromImage.
export const buildChatCompletionMessages = (messages: ChatMessage[]): ChatCompletionMessage[] => {
    return messages.map(message => {
        const contentParts: ChatCompletionContentPart[] = [];

        if (message.attachments && message.attachments.length > 0) {
            message.attachments.forEach(attachment => {
                contentParts.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${attachment.type};base64,${attachment.data}`,
                    },
                });
            });
        }

        if (message.content) {
            contentParts.push({
                type: "text",
                text: message.content,
            });
        }

        return {
            role: message.role === "assistant" ? "assistant" : "user",
            content: contentParts.length === 1 && contentParts[0].type === "text" ? contentParts[0].text : contentParts,
        };
    });
};

export const startLlamaServer = async () => {
    if (llamaServerStartPromise) {
        return llamaServerStartPromise;
    }

    llamaServerStartPromise = (async () => {
        // Prefer explicit overrides from Settings, but fall back to the canonical
        // AppData locations resolved in Rust. This makes the on-disk install — not
        // webview localStorage — the source of truth, so clearing browser storage
        // (or switching WebView2 profiles) can't strand a fully-installed app with
        // empty paths and no way to recover (see docs/design.md §7.5 / review F5).
        let modelPath = readSetting('modelPath');
        let mmprojPath = readSetting('mmprojPath');
        const backend = readSetting('hardwareBackend');

        if (!modelPath || !mmprojPath) {
            try {
                const paths = await invoke<{ model_path: string; mmproj_path: string }>("get_setup_paths");
                modelPath = modelPath || paths.model_path;
                mmprojPath = mmprojPath || paths.mmproj_path;
            } catch {
                /* fall through to the error below */
            }
        }

        if (!modelPath || !mmprojPath) {
            throw new Error("Model paths not configured — run the setup wizard.");
        }

        // The server binary path is resolved in Rust from AppData (not passed from
        // here) so a compromised webview can't point it at an arbitrary executable.
        const handle = await invoke<{ pid: number; port: number }>("start_llama_server", {
            modelPath,
            mmprojPath,
            backend,
        });

        cachedPort = handle.port;
        return handle.pid;
    })()
        .catch(err => {
            console.error("Failed to spawn llama server:", err);
            // Re-throw so the caller surfaces the real reason (missing files, etc.)
            // instead of silently treating a failed spawn as a started server.
            throw err instanceof Error ? err : new Error(String(err));
        })
        .finally(() => {
            llamaServerStartPromise = null;
        });

    return llamaServerStartPromise;
};

export const stopLlamaServer = async () => {
    try {
        await invoke("stop_llama_server");
    } catch (err) {
        console.error("Failed to stop llama server:", err);
    } finally {
        cachedPort = null;
    }
};

export const checkLlamaServerHealth = async () => {
    const base = await serverBaseUrl();
    if (!base) return false;
    try {
        const response = await fetch(`${base}/health`);
        if (response.status !== 200) return false;
        // The port is private/ephemeral, but a 200 alone doesn't prove the responder
        // is *our* llama-server rather than some unrelated local service that grabbed
        // the port in the sub-millisecond gap between pick_free_port and the spawn.
        // llama.cpp's /health answers `{"status":"ok"}`; assert that shape so we don't
        // start streaming completions at an impostor.
        const body = await response.json().catch(() => null);
        return body?.status === 'ok';
    } catch {
        return false;
    }
};

const SYSTEM_PROMPT =
    'You are a structured data extractor. ' +
    'Begin your response with the very first line of the requested format — no introduction, ' +
    'no analysis, no reasoning, no explanation before the data. ' +
    'Output only the data itself.';

type ExtractionStreamOptions = {
    messages: ChatCompletionMessage[];
    maxTokens: number;
    onContentDelta: (content: string) => void;
    signal?: AbortSignal;
};

// Dedicated extraction path: greedy sampler, no presence_penalty, logprobs on.
// Do not use streamChatCompletion for table extraction — it has different defaults.
export const extractTableFromImage = async ({
    messages,
    maxTokens,
    onContentDelta,
    signal,
}: ExtractionStreamOptions): Promise<{ content: string; logprobs: TokenLogprob[]; finishReason: string | null }> => {
    const messagesWithSystem: ChatCompletionMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
    ];

    const requestBody = {
        messages: messagesWithSystem,
        max_tokens: maxTokens,
        temperature: 0,
        top_p: 1,
        top_k: 1,
        presence_penalty: 0,
        stream: true,
        stop: ["<|im_start|>", "<|im_end|>"],
        chat_template_kwargs: { enable_thinking: false },
        logprobs: true,
        top_logprobs: 0,
    };

    const base = await serverBaseUrl();
    if (!base) throw new Error("The local model server is not running.");

    const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Streaming response body is unavailable.");

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let content = "";
    let charOffset = 0;
    let finishReason: string | null = null;
    const logprobs: TokenLogprob[] = [];
    // Track whether the server ever emitted a real (non-null) logprob. Confidence
    // scoring depends on llama.cpp's `choices[].logprobs.content[]` shape; if a future
    // server build changes or drops it, we still produce a table but every cell scores
    // as low/grey with no obvious cause. Surface that as a loud diagnostic (F7) rather
    // than letting the heatmap silently lie.
    let sawUsableLogprob = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;

            try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];

                // The terminating chunk carries finish_reason ("stop" | "length" | …)
                // on a choice whose delta is usually empty — capture it regardless.
                if (choice?.finish_reason) finishReason = choice.finish_reason;

                // A single delta can carry multiple tokens, each with its own logprob.
                // Iterate the full logprobs.content array (not just [0]) so per-token
                // offsets line up with the content we accumulate; a token without a
                // logprob is recorded as null so confidence scoring can exclude it
                // rather than defaulting it to 0 (= probability 1.0).
                const contentLogprobs = choice?.logprobs?.content;
                if (Array.isArray(contentLogprobs) && contentLogprobs.length > 0) {
                    for (const entry of contentLogprobs) {
                        const tok: string = entry?.token ?? "";
                        if (!tok) continue;
                        const logprob = typeof entry?.logprob === "number" ? entry.logprob : null;
                        if (logprob !== null) sawUsableLogprob = true;
                        logprobs.push({ token: tok, logprob, charOffset });
                        charOffset += tok.length;
                        content += tok;
                    }
                    onContentDelta(content);
                } else {
                    // No logprobs for this delta (e.g. logprobs disabled mid-stream).
                    // Still surface the visible text, recording a null logprob.
                    const tok: string = choice?.delta?.content ?? "";
                    if (tok) {
                        logprobs.push({ token: tok, logprob: null, charOffset });
                        charOffset += tok.length;
                        content += tok;
                        onContentDelta(content);
                    }
                }
            } catch (err) {
                console.error("Stream parse error:", err, data);
            }
        }
    }

    // Response-shape assertion: the model produced text but not one usable logprob.
    // That means the logprobs contract this server build speaks no longer matches what
    // confidence scoring expects — warn loudly so the cause is diagnosable instead of
    // surfacing as a mysteriously all-grey heatmap.
    if (content.length > 0 && !sawUsableLogprob) {
        console.warn(
            "llama-server returned no usable token logprobs — confidence scoring will be " +
            "degraded. The server's logprobs response shape may have changed; verify the " +
            "pinned llama.cpp build.",
        );
    }

    return { content, logprobs, finishReason };
};

export const streamChatCompletion = async ({ messages, onThinkingDelta, onContentDelta, onThinkingEnd, signal }: StreamChatCompletionOptions) => {
    const messagesWithSystem: ChatCompletionMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
    ];

    const requestBody: ChatCompletionRequestBody = {
        messages: messagesWithSystem,
        max_tokens: 3000,
        temperature: 0.7,
        top_p: 0.8,
        top_k: 20,
        presence_penalty: 1.5,
        stream: true,
        stop: ["<|im_start|>", "<|im_end|>"],
        chat_template_kwargs: { enable_thinking: false },
    };

    const base = await serverBaseUrl();
    if (!base) throw new Error("The local model server is not running.");

    const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal,
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();

    if (!reader) {
        throw new Error("Streaming response body is unavailable.");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let thinkingAssistantContent = "";
    let visibleAssistantContent = "";
    let contentStarted = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            if (!line.startsWith("data: ")) {
                continue;
            }

            const data = line.slice(6).trim();

            if (!data || data === "[DONE]") {
                continue;
            }

            try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta ?? {};
                const reasoningToken = delta.reasoning ?? delta.thinking ?? delta.reasoning_content ?? "";
                const contentToken = delta.content ?? "";

                if (reasoningToken) {
                    thinkingAssistantContent += reasoningToken;
                    onThinkingDelta(thinkingAssistantContent);
                }

                if (contentToken) {
                    if (!contentStarted) {
                        contentStarted = true;
                        onThinkingEnd();
                    }

                    visibleAssistantContent += contentToken;
                    onContentDelta(visibleAssistantContent);
                }
            } catch (streamError) {
                console.error("Stream parse error:", streamError, data);
            }
        }
    }

    if (!contentStarted) {
        onThinkingEnd();
    }

    const finalizedVisibleContent = visibleAssistantContent.trim();
    const finalizedThinkingContent = thinkingAssistantContent.trim();

    return {
        content: finalizedVisibleContent || (finalizedThinkingContent ? "" : "No visible response returned."),
        thinking: finalizedThinkingContent,
    };
};
