import ConfirmDialog from '../../components/ConfirmDialog';
import { deleteSession } from './sessionActions';

interface DeleteSessionDialogProps {
    /** The session pending deletion, or null when the dialog is closed. */
    session: { id: string; name: string } | null;
    /** Close the dialog (clear the pending selection). */
    onClose: () => void;
    /** Called after a successful delete so the caller can refresh its own list. */
    onDeleted?: () => void;
}

// Single home for the "Delete session?" confirmation. Both the sidebar's recent-list
// context menu and the Search results list opened identical dialogs and ran the same
// delete-then-cleanup logic; consolidating them here keeps the copy and the error
// handling from drifting (design review F12).
export function DeleteSessionDialog({ session, onClose, onDeleted }: DeleteSessionDialogProps) {
    const handleConfirm = async () => {
        if (!session) return;
        try {
            await deleteSession(session.id);
            onDeleted?.();
        } catch (error) {
            console.error('Failed to delete session:', error);
        } finally {
            onClose();
        }
    };

    return (
        <ConfirmDialog
            open={session !== null}
            title="Delete session?"
            description={
                session
                    ? `This will permanently delete "${session.name}" and all related files, outputs, and OCR data.`
                    : ''
            }
            confirmLabel="Delete"
            onConfirm={handleConfirm}
            onCancel={onClose}
        />
    );
}
