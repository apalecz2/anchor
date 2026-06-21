import { Modal } from './Modal';

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ConfirmDialog({
    open,
    title,
    description,
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    return (
        <Modal
            open={open}
            onClose={onCancel}
            role="alertdialog"
            labelledBy="confirm-dialog-title"
            describedBy="confirm-dialog-description"
            backdropClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[2px]"
            className="w-full max-w-sm rounded-[20px] border border-outline-variant bg-surface-bright p-6 text-on-surface shadow-2xl focus:outline-none"
        >
            <div className="space-y-2">
                <h2 id="confirm-dialog-title" className="text-lg font-semibold text-on-surface">
                    {title}
                </h2>
                <p id="confirm-dialog-description" className="text-sm leading-6 text-on-surface-variant">
                    {description}
                </p>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
                <button
                    type="button"
                    onClick={onCancel}
                    className="flex h-10 items-center justify-center rounded-[10px] bg-surface-variant px-4 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                >
                    {cancelLabel}
                </button>
                <button
                    type="button"
                    onClick={onConfirm}
                    className="flex h-10 items-center justify-center rounded-[10px] bg-error px-4 text-sm font-medium text-on-error transition-colors hover:bg-error/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                >
                    {confirmLabel}
                </button>
            </div>
        </Modal>
    );
}
