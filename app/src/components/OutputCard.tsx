import React from 'react';
import Icon from './Icon';

// Shared shell for an extraction output (raw text, formatted table): a bordered
// surface with a labeled header and an optional header action, so each output reads
// as a deliberate result rather than loose content on the pane.
export function OutputCard({ icon, title, action, subheader, fill = false, bodyClassName = 'px-5 py-4', children }: {
    icon: string;
    title: string;
    action?: React.ReactNode;
    /** Secondary header content (e.g. a legend), rendered below the title row. */
    subheader?: React.ReactNode;
    /** When true, the card fills its container's height and its body scrolls
        internally (header stays pinned) instead of the whole pane scrolling. */
    fill?: boolean;
    bodyClassName?: string;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <div className={`overflow-hidden rounded-xl border border-outline-variant bg-surface-bright shadow-sm${fill ? ' flex min-h-0 flex-1 flex-col' : ''}`}>
            <div className={`border-b border-outline-variant bg-surface-variant/40${fill ? ' shrink-0' : ''}`}>
                <div className="flex items-center justify-between gap-2 px-4 py-2">
                    <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-on-surface-variant">
                        <Icon name={icon} size={18} />
                        <span className="truncate">{title}</span>
                    </div>
                    {action}
                </div>
                {subheader && (
                    <div className="border-t border-outline-variant/60 px-4 py-2">
                        {subheader}
                    </div>
                )}
            </div>
            <div className={`${fill ? 'min-h-0 flex-1 overflow-auto ' : ''}${bodyClassName}`}>
                {children}
            </div>
        </div>
    );
}
