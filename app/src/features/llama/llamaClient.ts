import { invoke } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";

import type { ChatMessage } from "../extraction/types";
import { TABLE_EXTRACTION_SYSTEM_PROMPT } from "./promptUtils";

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
    // Grammar-constrained decoding (GBNF string) — enforces output format structurally
    grammar?: string;
    // Return per-token logprobs for confidence scoring; top_logprobs: 0 keeps only the chosen token
    logprobs?: boolean;
    top_logprobs?: number;
};

// Per-token logprob entry collected during streaming. charOffset is the
// start position of this token in the full assembled content string, so
// mapLogprobsToCells can assign tokens to cells by character range.
export type TokenLogprob = {
    token: string;
    logprob: number;   // ln(probability) — negative; closer to 0 = more confident
    charOffset: number;
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
    let charOffset = 0;
    const tokenLogprobs: TokenLogprob[] = [];

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
                const contentToken: string = delta.content ?? "";

                if (reasoningToken) {
                    thinkingAssistantContent += reasoningToken;
                    onThinkingDelta(thinkingAssistantContent);
                }

                if (contentToken) {
                    if (!contentStarted) {
                        contentStarted = true;
                        onThinkingEnd();
                    }

                    // Collect logprob for this token before advancing the offset.
                    // logprobs.content is an array; with top_logprobs:0 it has one entry.
                    const logprobEntry = parsed.choices?.[0]?.logprobs?.content?.[0];
                    if (logprobEntry != null) {
                        tokenLogprobs.push({
                            token: logprobEntry.token ?? contentToken,
                            logprob: logprobEntry.logprob,
                            charOffset,
                        });
                    }

                    charOffset += contentToken.length;
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
        tokenLogprobs,
    };
};

// ---------------------------------------------------------------------------
// Table extraction request (§5.1) — separate from general chat.
// Uses grammar-constrained decoding, logprobs, temperature 0.
// ---------------------------------------------------------------------------

export type TableExtractionRawResult = {
    rawOutput: string;       // untrimmed — charOffset values in tokenLogprobs align to this
    tokenLogprobs: TokenLogprob[];
};

export const streamTableExtraction = async ({
    imageBase64,
    imageType,
    ocrWordList,
    grammar: _grammar,
    maxTokens,
    onContentDelta,
    signal,
}: {
    imageBase64: string;
    imageType: string;
    ocrWordList: string;
    grammar: string;
    maxTokens: number;
    onContentDelta?: (content: string) => void;
    signal?: AbortSignal;
}): Promise<TableExtractionRawResult> => {
    const messages: ChatCompletionMessage[] = [
        { role: "system", content: TABLE_EXTRACTION_SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                { type: "image_url", image_url: { url: `data:${imageType};base64,${imageBase64}` } },
                { type: "text", text: ocrWordList },
            ],
        },
    ];

    // DEBUG: confirm the image content part is present and the data URL is well-formed.
    // If the server silently drops unrecognised content parts, the model sees only text.
    const userContent = messages[1].content as ChatCompletionContentPart[];
    const imgPart = userContent.find(p => p.type === "image_url") as { type: "image_url"; image_url: { url: string } } | undefined;
    console.log("[streamTableExtraction] image_url part present:", !!imgPart, "| url prefix:", imgPart?.image_url.url.slice(0, 30) ?? "(none)");
    console.log("[streamTableExtraction] content parts:", userContent.map(p => p.type).join(", "));

    // TEST 1: grammar removed to isolate whether the GBNF is forcing the loop.
    // A malformed grammar can leave the model with only looping token continuations.
    // Restore `grammar,` here once the cause is confirmed.
    const requestBody: ChatCompletionRequestBody = {
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 20,
        presence_penalty: 0,
        stream: true,
        stop: ["<|im_start|>", "<|im_end|>"],
        chat_template_kwargs: { enable_thinking: false },
        // grammar,  // TEST 1: omitted
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
    let rawOutput = "";
    let charOffset = 0;
    const tokenLogprobs: TokenLogprob[] = [];

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
                const contentToken: string = parsed.choices?.[0]?.delta?.content ?? "";
                if (!contentToken) continue;

                const logprobEntry = parsed.choices?.[0]?.logprobs?.content?.[0];
                if (logprobEntry != null) {
                    tokenLogprobs.push({
                        token: logprobEntry.token ?? contentToken,
                        logprob: logprobEntry.logprob,
                        charOffset,
                    });
                }

                charOffset += contentToken.length;
                rawOutput += contentToken;
                onContentDelta?.(rawOutput);
            } catch (e) {
                console.error("Stream parse error:", e);
            }
        }
    }

    return { rawOutput, tokenLogprobs };
};
