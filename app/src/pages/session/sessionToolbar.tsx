import React from 'react';
import Icon from '../../components/Icon';

// Shared style for the square icon buttons in the floating pane toolbars.
export const iconBtnClass = "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-variant text-on-surface transition-colors shadow-sm hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20";

// The help island that sits to the right of each pane's floating toolbar: a single
// info button in its own rounded surface, always available while a page is loaded.
export function HelpIsland({ onClick, label }: { onClick: () => void; label: string }): React.ReactElement {
    return (
        <div className="pointer-events-auto flex items-center rounded-2xl border border-outline-variant bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm">
            <button
                onClick={onClick}
                aria-label={label}
                title="Help"
                type="button"
                className={iconBtnClass}
            >
                <Icon name="info" size={18} />
            </button>
        </div>
    );
}
