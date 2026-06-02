export type BoundingBox = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export type OcrWord = {
    text: string;
    confidence: number;
    box_coords: BoundingBox;
    pageNumber: number;
    blockNumber: number;
    paragraphNumber: number;
    lineNumber: number;
    wordNumber: number;
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