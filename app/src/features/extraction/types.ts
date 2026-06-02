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

export interface BoundingBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface OcrWord {
    text: string;
    confidence: number;
    box_coords: BoundingBox;
}

export interface DocumentPageResult {
    image_path: string;
    natural_width: number;
    natural_height: number;
    words: OcrWord[];
    text: string;
}

export interface ExtractionResult {
    session_id: string;
    pages: DocumentPageResult[];
}

export interface LineWord {
    text: string;
    originalIndex: number;
}