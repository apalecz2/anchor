export type BoundingBox = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export type OcrWord = {
    id: string;
    text: string;
    confidence: number;
    box_coords: BoundingBox;
};

export type OcrProgress = {
    status: string;
    progress: number;
};

export type OcrResult = {
    text: string;
    words: OcrWord[];
    meanConfidence: number;
};