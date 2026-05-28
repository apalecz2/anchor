export type FileAttachment = {
    name: string;
    type: string;
    data: string;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
    id: number;
    role: ChatRole;
    content: string;
    thinking?: string;
    isThinkingOpen?: boolean;
    isStreaming?: boolean;
    attachments?: FileAttachment[];
};
