import React from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface ModalProps {
    /** Whether the dialog is shown. Renders nothing when false. */
    open: boolean;
    /** Invoked on Escape, backdrop click, and (by convention) a Cancel/Close button. */
    onClose: () => void;
    children: React.ReactNode;
    /** Panel (dialog box) classes: sizing, padding, radius, background, shadow. */
    className?: string;
    /**
     * Backdrop wrapper classes. Defaults to a fixed, full-viewport dimmed layer.
     * Override for the in-pane variant (e.g. `absolute inset-0 … bg-black/40`) or a
     * different dim/blur.
     */
    backdropClassName?: string;
    role?: 'dialog' | 'alertdialog';
    /** id of the element labelling the dialog (maps to aria-labelledby). */
    labelledBy?: string;
    /** id of the element describing the dialog (maps to aria-describedby). */
    describedBy?: string;
    /**
     * Render into document.body via a portal, so a `container-type`/`overflow-hidden`
     * ancestor can't clip or mis-anchor the fixed overlay.
     */
    portal?: boolean;
}

const DEFAULT_BACKDROP = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';

/**
 * Shared modal scaffolding. Consolidates the backdrop + centered panel + accessible
 * dialog behaviour (Escape/focus-trap/focus-restore via useDialogA11y, backdrop-click
 * to close, click-through guard on the panel) that ConfirmDialog, WordEditModal, and
 * the Session help overlay each re-implemented. Callers supply only the panel content
 * and the classes that actually differ (panel size/shape, backdrop dim, portal-or-not).
 */
export function Modal({
    open,
    onClose,
    children,
    className,
    backdropClassName = DEFAULT_BACKDROP,
    role = 'dialog',
    labelledBy,
    describedBy,
    portal = false,
}: ModalProps): React.ReactElement | null {
    // Escape-to-close, focus trap, focus restore, and initial focus. Called before the
    // early return so hook order stays stable across open/closed renders.
    const dialogRef = useDialogA11y<HTMLDivElement>({ active: open, onClose });

    if (!open) return null;

    const overlay = (
        <div className={backdropClassName} role="presentation" onClick={onClose}>
            <div
                ref={dialogRef}
                tabIndex={-1}
                role={role}
                aria-modal="true"
                aria-labelledby={labelledBy}
                aria-describedby={describedBy}
                className={className}
                onClick={(event) => event.stopPropagation()}
            >
                {children}
            </div>
        </div>
    );

    return portal ? createPortal(overlay, document.body) : overlay;
}

export default Modal;
