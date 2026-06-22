import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WordEditModal } from './WordEditModal';

describe('WordEditModal', () => {
    it('shows the Add title when there is no id', () => {
        render(<WordEditModal initialData={{}} onSave={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByText('Add Missing Text')).toBeInTheDocument();
    });

    it('shows the Edit title and pre-fills text when editing', () => {
        render(
            <WordEditModal
                initialData={{ id: 'w1', text: 'Hello' }}
                onSave={vi.fn()}
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByText('Edit Word')).toBeInTheDocument();
        expect(screen.getByRole('textbox')).toHaveValue('Hello');
    });

    it('updates the input as the user types', () => {
        render(<WordEditModal initialData={{}} onSave={vi.fn()} onClose={vi.fn()} />);
        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: 'new value' } });
        expect(input).toHaveValue('new value');
    });

    it('fires onSave with the current text from the Save button', () => {
        const onSave = vi.fn();
        render(<WordEditModal initialData={{ text: 'x' }} onSave={onSave} onClose={vi.fn()} />);
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).toHaveBeenCalledWith('edited');
    });

    it('fires onSave on Enter', () => {
        const onSave = vi.fn();
        render(<WordEditModal initialData={{ text: 'z' }} onSave={onSave} onClose={vi.fn()} />);
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
        expect(onSave).toHaveBeenCalledWith('z');
    });

    it('fires onClose from Cancel and Escape', () => {
        const onClose = vi.fn();
        render(<WordEditModal initialData={{}} onSave={vi.fn()} onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('puts initial focus on the input', () => {
        render(<WordEditModal initialData={{}} onSave={vi.fn()} onClose={vi.fn()} />);
        expect(document.activeElement).toBe(screen.getByRole('textbox'));
    });
});
