import { describe, it, expect } from 'vitest';
import {
    estimateTokens,
    estimateExtractionBudget,
    CONTEXT_SIZE,
    IMAGE_TOKEN_ESTIMATE,
    MIN_OUTPUT_TOKENS,
} from './contextBudget';

describe('estimateTokens', () => {
    it('approximates ~4 characters per token', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens('abcd')).toBe(1);
        expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
    });
});

describe('estimateExtractionBudget', () => {
    it('reserves image tokens and leaves the rest for output on a small prompt', () => {
        const budget = estimateExtractionBudget('a few words of OCR text');
        expect(budget.promptTokens).toBe(IMAGE_TOKEN_ESTIMATE + estimateTokens('a few words of OCR text'));
        expect(budget.availableOutputTokens).toBe(CONTEXT_SIZE - budget.promptTokens);
        expect(budget.overflow).toBe(false);
    });

    it('flags overflow when the prompt leaves less than the minimum output room', () => {
        // Build text whose token estimate consumes nearly the whole context.
        const charsToFillContext = (CONTEXT_SIZE - IMAGE_TOKEN_ESTIMATE) * 4;
        const dense = 'x'.repeat(charsToFillContext);
        const budget = estimateExtractionBudget(dense);
        expect(budget.availableOutputTokens).toBeLessThan(MIN_OUTPUT_TOKENS);
        expect(budget.overflow).toBe(true);
    });

    it('never reports negative output room', () => {
        const huge = 'x'.repeat(CONTEXT_SIZE * 8);
        expect(estimateExtractionBudget(huge).availableOutputTokens).toBe(0);
    });
});
