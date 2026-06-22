import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useDialogA11y } from './useDialogA11y';

// Minimal harness component that mounts the hook on a container with some
// focusable children, mirroring how Modal uses it.
function Dialog({
    active,
    onClose,
    children,
}: {
    active: boolean;
    onClose: () => void;
    children?: React.ReactNode;
}) {
    const ref = useDialogA11y<HTMLDivElement>({ active, onClose });
    return (
        <div ref={ref} tabIndex={-1} data-testid="dialog">
            {children}
        </div>
    );
}

describe('useDialogA11y', () => {
    it('closes on Escape', () => {
        const onClose = vi.fn();
        render(
            <Dialog active onClose={onClose}>
                <button>First</button>
            </Dialog>,
        );
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('moves initial focus to the first focusable control', () => {
        render(
            <Dialog active onClose={() => {}}>
                <button>First</button>
                <button>Second</button>
            </Dialog>,
        );
        expect(document.activeElement).toBe(screen.getByText('First'));
    });

    it('falls back to focusing the container when there is no focusable child (L10)', () => {
        render(<Dialog active onClose={() => {}} />);
        expect(document.activeElement).toBe(screen.getByTestId('dialog'));
    });

    it('wraps Tab from the last element back to the first', () => {
        render(
            <Dialog active onClose={() => {}}>
                <button>First</button>
                <button>Last</button>
            </Dialog>,
        );
        const last = screen.getByText('Last');
        last.focus();
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(screen.getByText('First'));
    });

    it('wraps Shift+Tab from the first element to the last', () => {
        render(
            <Dialog active onClose={() => {}}>
                <button>First</button>
                <button>Last</button>
            </Dialog>,
        );
        const first = screen.getByText('First');
        first.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(screen.getByText('Last'));
    });

    it('registers no listeners when inactive', () => {
        const onClose = vi.fn();
        render(
            <Dialog active={false} onClose={onClose}>
                <button>First</button>
            </Dialog>,
        );
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('restores focus to the opener on unmount', () => {
        const opener = document.createElement('button');
        opener.textContent = 'Opener';
        document.body.appendChild(opener);
        opener.focus();
        expect(document.activeElement).toBe(opener);

        const { unmount } = render(
            <Dialog active onClose={() => {}}>
                <button>First</button>
            </Dialog>,
        );
        expect(document.activeElement).not.toBe(opener);
        unmount();
        expect(document.activeElement).toBe(opener);
        opener.remove();
    });
});
