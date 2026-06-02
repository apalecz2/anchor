import React, { useState, useEffect } from 'react';
import { BoundingBox } from '../../features/extraction/types';

interface WordEditModalProps {
    initialData: { box?: BoundingBox | null; index?: number; text?: string };
    onSave: (text: string) => void;
    onClose: () => void;
}

export const WordEditModal: React.FC<WordEditModalProps> = ({ initialData, onSave, onClose }) => {
    const [text, setText] = useState(initialData.text || "");
    const isEditing = initialData.index !== undefined;

    useEffect(() => {
        setText(initialData.text || "");
    }, [initialData]);

    return (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-50">
            <div className="bg-surface-bright p-6 rounded-xl shadow-lg border border-outline-variant w-80">
                <h3 className="text-primary font-bold mb-4">
                    {isEditing ? "Edit Word" : "Add Missing Text"}
                </h3>
                <input
                    type="text"
                    autoFocus
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