import { describe, it, expect, vi } from 'vitest';
import { emitSessionChange, subscribeToSessionChanges } from './sessionEvents';

// Runs in the jsdom project where `window` exists, exercising real delivery.
describe('sessionEvents — delivery (jsdom)', () => {
    it('delivers the detail to a subscribed listener', () => {
        const listener = vi.fn();
        subscribeToSessionChanges(listener);
        emitSessionChange({ deletedSessionId: 'abc' });
        expect(listener).toHaveBeenCalledWith({ deletedSessionId: 'abc' });
    });

    it('stops delivering after unsubscribe', () => {
        const listener = vi.fn();
        const unsub = subscribeToSessionChanges(listener);
        unsub();
        emitSessionChange({ allDeleted: true });
        expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple independent subscribers', () => {
        const a = vi.fn();
        const b = vi.fn();
        subscribeToSessionChanges(a);
        subscribeToSessionChanges(b);
        emitSessionChange({ deletedSessionId: 'x' });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });
});
