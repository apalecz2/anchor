import { useEffect, useRef } from 'react';

// Elements that can receive keyboard focus inside a dialog — used both to scope the
// focus trap and to choose the initial focus target.
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

type DialogA11yOptions = {
    /** Whether the dialog is currently shown. Listeners/trap are active only while true. */
    active: boolean;
    /** Invoked on Escape; callers typically reuse this for backdrop/Cancel clicks too. */
    onClose: () => void;
};

/**
 * Wires the standard accessible-dialog behaviours onto a container element:
 *  - moves focus into the dialog on open (first focusable control, else the container),
 *  - traps Tab / Shift+Tab focus within the dialog,
 *  - closes on Escape,
 *  - restores focus to the previously-focused element on close.
 *
 * Returns a ref to attach to the dialog's container element. Give that element
 * `tabIndex={-1}` so the container can receive focus when it has no focusable child.
 */
export function useDialogA11y<T extends HTMLElement = HTMLDivElement>({ active, onClose }: DialogA11yOptions) {
    const containerRef = useRef<T>(null);
    // Hold the latest onClose so a new inline callback each render doesn't re-run
    // (and re-trigger the focus dance of) the effect below.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!active) return;
        const container = containerRef.current;
        if (!container) return;

        const previouslyFocused = document.activeElement as HTMLElement | null;
        const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

        // Initial focus: first focusable control, falling back to the container itself.
        (focusables()[0] ?? container).focus();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;

            const items = focusables();
            if (items.length === 0) {
                // Nothing to tab to — keep focus on the container rather than letting
                // it escape to the page behind the dialog.
                event.preventDefault();
                return;
            }

            const first = items[0];
            const last = items[items.length - 1];
            const activeEl = document.activeElement;

            // Wrap at the ends so Tab can never move focus outside the dialog.
            if (event.shiftKey && activeEl === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && activeEl === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            previouslyFocused?.focus?.();
        };
    }, [active]);

    return containerRef;
}
