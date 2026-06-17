import { createContext, useEffect, useRef, useState, type ReactNode } from "react";

import { buildChatCompletionMessages, checkLlamaServerHealth, getLlamaServerStatus, startLlamaServer, stopLlamaServer, streamChatCompletion } from "./llamaClient.ts";

import type { ChatMessage, FileAttachment } from "../extraction/types";

type LlamaChatContextValue = {
    isServerReady: boolean;
    isServerStarting: boolean;
    isLoading: boolean;
    serverError: string | null;
    // --- Conversational chat path (no UI caller yet) -------------------------
    // Reserved for the planned chat / "ask the model to fix columns" feature
    // (design §8 generative edits). Intentionally retained, not dead code; keep in
    // sync with the chat helpers in llamaClient.ts when that feature lands.
    messages: ChatMessage[];
    pendingAttachment: FileAttachment | null;
    attachImage: (file: File) => Promise<boolean>;
    removePendingAttachment: () => void;
    /** Resolves true once the server reports healthy, false if it failed to start
     *  (the reason is also placed in `serverError`). Cancels any pending idle unload. */
    startServer: () => Promise<boolean>;
    stopServer: () => Promise<void>;
    /** Release the server after a job: keep it warm for a short idle window so an
     *  immediate re-extract is instant, then unload to free RAM. A new startServer
     *  cancels the pending unload. */
    releaseServer: () => void;
    sendMessage: (text: string, attachmentOverride?: FileAttachment | null) => Promise<string | null>;
};

export const LlamaChatContext = createContext<LlamaChatContextValue | null>(null);

const readImageFile = (file: File) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = event => {
            const dataUrl = event.target?.result as string;
            resolve(dataUrl.split(",")[1] ?? "");
        };

        reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
        reader.readAsDataURL(file);
    });

export const LlamaChatProvider = ({ children }: { children: ReactNode }) => {
    const [isServerReady, setIsServerReady] = useState(false);
    const [isServerStarting, setIsServerStarting] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [pendingAttachment, setPendingAttachment] = useState<FileAttachment | null>(null);

    const messageCounterRef = useRef(0);
    const activeRequestRef = useRef<AbortController | null>(null);
    const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const idleUnloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isMountedRef = useRef(true);

    // How long to keep the model resident after a job finishes. Long enough that a
    // user tweaking and re-extracting doesn't reload (tens of seconds for a 2.7 GB
    // GGUF), short enough that an idle session releases its RAM (design §6).
    const IDLE_UNLOAD_MS = 90_000;

    const allocateMessageId = () => {
        messageCounterRef.current += 1;
        return messageCounterRef.current;
    };

    const cancelIdleUnload = () => {
        if (idleUnloadRef.current !== null) {
            clearTimeout(idleUnloadRef.current);
            idleUnloadRef.current = null;
        }
    };

    const stopWatchdog = () => {
        if (watchdogRef.current !== null) {
            clearInterval(watchdogRef.current);
            watchdogRef.current = null;
        }
    };

    // Slow watchdog: only runs after server is confirmed up.
    // Detects unexpected server death and clears ready state.
    const startWatchdog = () => {
        stopWatchdog();
        watchdogRef.current = setInterval(async () => {
            const isHealthy = await checkLlamaServerHealth();
            if (!isHealthy && isMountedRef.current) {
                setIsServerReady(false);
                stopWatchdog();
            }
        }, 30_000);
    };

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            stopWatchdog();
            cancelIdleUnload();
            activeRequestRef.current?.abort();
            void stopLlamaServer();
        };
    }, []);

    // Loading a multi-GB GGUF from cold disk on the 8 GB minimum spec can take well
    // over a minute, so the old fixed 60 s budget failed setup-correct installs. We
    // poll up to this long but bail early the moment the process is seen to have died.
    const READINESS_TIMEOUT_MS = 180_000;

    const startServer = async (): Promise<boolean> => {
        // A new job cancels any pending idle unload, whether or not the server is up.
        cancelIdleUnload();
        if (isServerReady) return true;
        if (isServerStarting) return false;

        setIsServerStarting(true);
        setServerError(null);

        try {
            await startLlamaServer();

            const deadline = Date.now() + READINESS_TIMEOUT_MS;
            while (Date.now() < deadline) {
                if (await checkLlamaServerHealth()) {
                    setIsServerReady(true);
                    startWatchdog();
                    return true;
                }

                // Fail fast on a crashed process (bad GGUF, OOM) rather than waiting
                // out the full timeout for a server that will never report healthy.
                if (await getLlamaServerStatus() === 'exited') {
                    setServerError('The model server exited while loading — the model file may be corrupt or there may not be enough free RAM. See logs/llama-server.log in the app data folder for details.');
                    return false;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            setServerError('The model server did not finish loading in time. A large model on a slow disk can take a while — retry, or free up RAM and try again.');
            return false;
        } catch (err) {
            setServerError(err instanceof Error ? err.message : 'Failed to start server.');
            return false;
        } finally {
            setIsServerStarting(false);
        }
    };

    const stopServer = async () => {
        cancelIdleUnload();
        stopWatchdog();
        await stopLlamaServer();
        setIsServerReady(false);
        setIsServerStarting(false);
    };

    // Defer the unload so a quick re-extract keeps the warm server. The timer is
    // cancelled by the next startServer (or an explicit stopServer / unmount).
    const releaseServer = () => {
        cancelIdleUnload();
        idleUnloadRef.current = setTimeout(() => {
            idleUnloadRef.current = null;
            void stopServer();
        }, IDLE_UNLOAD_MS);
    };

    // -------------------------------------------------------------------------
    // Conversational chat path: attachImage / removePendingAttachment / sendMessage.
    // No UI currently calls these — they are intentionally retained for the planned
    // chat feature (design §8), not accidental dead code. The extraction flow uses
    // requestTableFormat (useLlamaChat.ts) instead.
    // -------------------------------------------------------------------------
    const attachImage = async (file: File) => {
        if (!file.type.startsWith("image/")) {
            return false;
        }

        const base64Data = await readImageFile(file);

        setPendingAttachment({
            name: file.name,
            type: file.type || "application/octet-stream",
            data: base64Data,
        });

        return true;
    };

    const removePendingAttachment = () => {
        setPendingAttachment(null);
    };

    const sendMessage = async (text: string, attachmentOverride: FileAttachment | null = null) => {
        const userMessage = text.trim();
        const serverReady = isServerReady || await checkLlamaServerHealth();

        if (serverReady && !isServerReady) {
            setIsServerReady(true);
        }

        if ((!userMessage && !pendingAttachment) || !serverReady || isLoading) {
            return null;
        }

        const currentAttachment = attachmentOverride ?? pendingAttachment;
        const userMessageId = allocateMessageId();
        const assistantMessageId = allocateMessageId();

        setPendingAttachment(null);
        setMessages(prev => [
            ...prev,
            {
                id: userMessageId,
                role: "user",
                content: userMessage,
                attachments: currentAttachment ? [currentAttachment] : undefined,
            },
            {
                id: assistantMessageId,
                role: "assistant",
                content: "",
                thinking: "",
                isThinkingOpen: true,
                isStreaming: true,
            },
        ]);

        setIsLoading(true);

        const conversationMessages = [...messages, {
            id: userMessageId,
            role: "user" as const,
            content: userMessage,
            attachments: currentAttachment ? [currentAttachment] : undefined,
        }];

        const requestBody = {
            messages: buildChatCompletionMessages(conversationMessages),
            max_tokens: 4096,
            temperature: 0.7,
            stream: true as const,
            stop: ["<|im_start|>", "<|im_end|>"],
        };

        activeRequestRef.current?.abort();
        activeRequestRef.current = new AbortController();

        try {
            const finalAssistantMessage = await streamChatCompletion({
                messages: requestBody.messages,
                onThinkingDelta: (nextThinkingContent: string) => {
                    setMessages(prev => prev.map(message => message.id === assistantMessageId ? {
                        ...message,
                        thinking: nextThinkingContent,
                        isThinkingOpen: true,
                    } : message));
                },
                onContentDelta: (nextVisibleContent: string) => {
                    setMessages(prev => prev.map(message => message.id === assistantMessageId ? {
                        ...message,
                        content: nextVisibleContent,
                        isThinkingOpen: false,
                        isStreaming: true,
                    } : message));
                },
                onThinkingEnd: () => {
                    setMessages(prev => prev.map(message => message.id === assistantMessageId ? {
                        ...message,
                        isThinkingOpen: false,
                    } : message));
                },
                signal: activeRequestRef.current.signal,
            });

            setMessages(prev => prev.map(message => message.id === assistantMessageId ? {
                ...message,
                content: finalAssistantMessage.content,
                thinking: finalAssistantMessage.thinking,
                isThinkingOpen: false,
                isStreaming: false,
            } : message));

            return finalAssistantMessage.content;
        } catch (error) {
            console.error("Request failed:", error);

            setMessages(prev => prev.map(message => message.id === assistantMessageId ? {
                ...message,
                content: error instanceof Error && error.name === "AbortError"
                    ? "Request cancelled."
                    : "Error: Request failed.",
                isStreaming: false,
            } : message));

            return null;
        } finally {
            setIsLoading(false);
            if (activeRequestRef.current?.signal.aborted) {
                activeRequestRef.current = null;
            }
        }
    };

    const contextValue: LlamaChatContextValue = {
        isServerReady,
        isServerStarting,
        isLoading,
        serverError,
        messages,
        pendingAttachment,
        attachImage,
        removePendingAttachment,
        startServer,
        stopServer,
        releaseServer,
        sendMessage,
    };

    return <LlamaChatContext.Provider value={contextValue}>{children}</LlamaChatContext.Provider>;
};
