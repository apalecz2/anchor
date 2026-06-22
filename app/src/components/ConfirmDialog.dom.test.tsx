import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmDialog from './ConfirmDialog';

const base = {
    title: 'Delete session?',
    description: 'This cannot be undone.',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
};

describe('ConfirmDialog', () => {
    it('renders title and description when open', () => {
        render(<ConfirmDialog open {...base} />);
        expect(screen.getByText('Delete session?')).toBeInTheDocument();
        expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    });

    it('renders nothing when closed', () => {
        const { container } = render(<ConfirmDialog open={false} {...base} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('fires onConfirm and onCancel from the buttons', () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        render(<ConfirmDialog open {...base} onConfirm={onConfirm} onCancel={onCancel} />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('closes on backdrop click but not on inner click', () => {
        const onCancel = vi.fn();
        render(<ConfirmDialog open {...base} onCancel={onCancel} />);
        const dialog = screen.getByRole('alertdialog');
        // inner click does not close
        fireEvent.click(dialog);
        expect(onCancel).not.toHaveBeenCalled();
        // backdrop (the presentation parent) does
        fireEvent.click(dialog.parentElement!);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('has the alertdialog role and is modal', () => {
        render(<ConfirmDialog open {...base} />);
        const dialog = screen.getByRole('alertdialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('uses custom confirm/cancel labels', () => {
        render(<ConfirmDialog open {...base} confirmLabel="Remove" cancelLabel="Keep" />);
        expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
    });
});
