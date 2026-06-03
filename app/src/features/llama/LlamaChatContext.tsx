import { createContext, useEffect, useRef, useState, type ReactNode } from "react";

import { buildChatCompletionMessages, checkLlamaServerHealth, startLlamaServer, stopLlamaServer, streamChatCompletion } from "./llamaClient.ts";

import type { ChatMessage, FileAttachment } from "../extraction/types";

type LlamaChatContextValue = {
    isServerReady: boolean;
    isServerStarting: boolean;
    isLoading: boolean;
    serverError: string | null;
    messages: ChatMessage[];
    pendingAttachment: FileAttachment | null;
    attachImage: (file: File) => Promise<boolean>;
    removePendingAttachment: () => void;
    startServer: () => Promise<void>;
    stopServer: () => Promise<void>;
    sendMessage: (text: string, attachmentOverride?: FileAttachment | null) => Promise<boolean>;
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
    const isMountedRef = useRef(true);

    const allocateMessageId = () => {
        messageCounterRef.current += 1;
        return messageCounterRef.current;
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
            activeRequestRef.current?.abort();
            void stopLlamaServer();
        };
    }, []);

    const startServer = async () => {
        if (isServerReady || isServerStarting) {
            return;
        }

        setIsServerStarting(true);
        setServerError(null);

        try {
            await startLlamaServer();

            for (let attempt = 0; attempt < 60; attempt += 1) {
                if (await checkLlamaServerHealth()) {
                    setIsServerReady(true);
                    startWatchdog();
                    return;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            setServerError('Server did not become ready within 60 seconds. Check that the model file exists and you have enough RAM.');
        } catch (err) {
            setServerError(err instanceof Error ? err.message : 'Failed to start server.');
        } finally {
            setIsServerStarting(false);
        }
    };

    const stopServer = async () => {
        if (!isServerReady && !isServerStarting) {
            return;
        }

        stopWatchdog();
        await stopLlamaServer();
        setIsServerReady(false);
        setIsServerStarting(false);
    };

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
            return false;
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

            return true;
        } catch (error) {
            console.error("Request failed:", error);

            setMessages(prev => prev.map(message => message.id === assistantMessageId ? {
                ...message,
                content: error instanceof Error && error.name === "AbortError"
                    ? "Request cancelled."
                    : "Error: Request failed.",
                isStreaming: false,
            } : message));

            return false;
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
        sendMessage,
    };

    return <LlamaChatContext.Provider value={contextValue}>{children}</LlamaChatContext.Provider>;
};
