import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const deleteSession = vi.fn().mockResolvedValue(undefined);
vi.mock('./sessionActions', () => ({ deleteSession: (id: string) => deleteSession(id) }));

import { DeleteSessionDialog } from './DeleteSessionDialog';

const session = { id: 's1', name: 'My Doc' };

beforeEach(() => vi.clearAllMocks());

describe('DeleteSessionDialog (CR:F12)', () => {
    it('is closed (renders nothing) when session is null', () => {
        const { container } = render(
            <DeleteSessionDialog session={null} onClose={vi.fn()} onDeleted={vi.fn()} />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('shows the session name in the description when open', () => {
        render(<DeleteSessionDialog session={session} onClose={vi.fn()} onDeleted={vi.fn()} />);
        expect(screen.getByText(/My Doc/)).toBeInTheDocument();
    });

    it('confirm deletes the session, fires onDeleted, then closes', async () => {
        const onClose = vi.fn();
        const onDeleted = vi.fn();
        render(<DeleteSessionDialog session={session} onClose={onClose} onDeleted={onDeleted} />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('s1'));
        await waitFor(() => expect(onDeleted).toHaveBeenCalled());
        expect(onClose).toHaveBeenCalled();
    });

    it('cancel closes without deleting', () => {
        const onClose = vi.fn();
        render(<DeleteSessionDialog session={session} onClose={onClose} onDeleted={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalled();
        expect(deleteSession).not.toHaveBeenCalled();
    });

    it('still closes when delete throws', async () => {
        const onClose = vi.fn();
        deleteSession.mockRejectedValueOnce(new Error('db down'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        render(<DeleteSessionDialog session={session} onClose={onClose} onDeleted={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
});
