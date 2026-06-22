import { describe, it, expect } from 'vitest';
import { emitSessionChange, subscribeToSessionChanges } from './sessionEvents';

// Runs in the node project where `window` is undefined, exercising the SSR guard.
describe('sessionEvents — SSR guard (no window)', () => {
    it('emit is a no-op and does not throw', () => {
        expect(typeof window).toBe('undefined');
        expect(() => emitSessionChange({ allDeleted: true })).not.toThrow();
    });

    it('subscribe returns a callable no-op unsubscribe', () => {
        const unsub = subscribeToSessionChanges(() => {});
        expect(() => unsub()).not.toThrow();
    });
});
