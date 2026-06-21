import React, { useState, useEffect, useRef } from 'react';
import Icon from './Icon';

// Copy action with a transient "Copied" confirmation. `onCopy` does the clipboard
// write (and may throw); the button only shows success when it resolves.
export function CopyButton({ onCopy, label = 'Copy' }: { onCopy: () => Promise<void> | void; label?: string }): React.ReactElement {
    const [copied, setCopied] = useState(false);
    const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (resetRef.current) clearTimeout(resetRef.current); }, []);

    const handle = async () => {
        try {
            await onCopy();
            setCopied(true);
            if (resetRef.current) clearTimeout(resetRef.current);
            resetRef.current = setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard unavailable — nothing actionable to surface */
        }
    };

    return (
        <button
            onClick={handle}
            aria-label={copied ? 'Copied to clipboard' : `${label} (copies to clipboard)`}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
            <Icon name={copied ? 'check' : 'content_copy'} size={18} className={copied ? 'text-green-600' : ''} />
            {copied ? 'Copied' : label}
        </button>
    );
}
