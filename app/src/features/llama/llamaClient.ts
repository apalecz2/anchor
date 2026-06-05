import { invoke } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";

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
        const llamaServerPath = await invoke<string>("resolve_llama_server_path");
        const modelPath = await resolveResource("models/Qwen3.5-4B-Q4_K_M.gguf");
        const mmprojPath = await resolveResource("models/mmproj-F16.gguf");

        const pid = await invoke<number>("start_llama_server", {
            modelPath,
            mmprojPath,
            llamaServerPath,
        });

        return pid;
    })()
        .catch(err => {
            console.error("Failed to spawn llama server:", err);
            return null;
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
    }
};

export const checkLlamaServerHealth = async () => {
    try {
        const response = await fetch("http://127.0.0.1:8080/health");
        return response.status === 200;
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
}: ExtractionStreamOptions): Promise<{ content: string; logprobs: TokenLogprob[] }> => {
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

    const response = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
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
    const logprobs: TokenLogprob[] = [];

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
                const token: string = choice?.delta?.content ?? "";
                const logprobEntry = choice?.logprobs?.content?.[0];

                if (token) {
                    logprobs.push({
                        token,
                        logprob: logprobEntry?.logprob ?? 0,
                        charOffset,
                    });
                    charOffset += token.length;
                    content += token;
                    onContentDelta(content);
                }
            } catch (err) {
                console.error("Stream parse error:", err, data);
            }
        }
    }

    return { content, logprobs };
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

    const response = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
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
