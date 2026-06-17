import React, { useState, useEffect } from 'react';
import type { BoundingBox } from '../../features/ocr/types';
import { useDialogA11y } from '../../hooks/useDialogA11y';

interface WordEditModalProps {
    initialData: { box?: BoundingBox | null; id?: string; text?: string };
    onSave: (text: string) => void;
    onClose: () => void;
}

export const WordEditModal: React.FC<WordEditModalProps> = ({ initialData, onSave, onClose }) => {
    const [text, setText] = useState(initialData.text || "");
    const isEditing = initialData.id !== undefined;

    // Escape-to-close, focus trap, and focus restore; the hook also moves initial
    // focus to the input (the first focusable control), so no manual autoFocus.
    const dialogRef = useDialogA11y<HTMLDivElement>({ active: true, onClose: onClose });

    useEffect(() => {
        setText(initialData.text || "");
    }, [initialData]);

    return (
        <div
            className="absolute inset-0 flex items-center justify-center bg-black/40 z-50"
            role="presentation"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="word-edit-modal-title"
                className="bg-surface-bright p-6 rounded-xl shadow-lg border border-outline-variant w-80 focus:outline-none"
                onClick={(event) => event.stopPropagation()}
            >
                <h3 id="word-edit-modal-title" className="text-primary font-bold mb-4">
                    {isEditing ? "Edit Word" : "Add Missing Text"}
                </h3>
                <input
                    type="text"
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') onSave(text);
                    }}
                    className="w-full p-2 mb-4 border border-outline rounded bg-surface text-on-surface"
                    placeholder="Type text here..."
                />
                <div className="flex justify-end gap-2">
                    <button onClick={onClose} className="px-4 py-2 text-on-surface-variant hover:bg-surface-variant rounded">Cancel</button>
                    <button onClick={() => onSave(text)} className="px-4 py-2 bg-primary text-on-primary rounded hover:bg-primary/90">Save</button>
                </div>
            </div>
        </div>
    );
};