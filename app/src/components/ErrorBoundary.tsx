import React from 'react';

interface Props {
    children: React.ReactNode;
}

interface State {
    error: Error | null;
}

/**
 * Top-level error boundary. A render-time throw anywhere below this point (e.g. a
 * stale provenance mapping, a malformed DB row) would otherwise unmount the entire
 * React tree and leave a blank window with no way to recover. This catches it and
 * shows an actionable fallback instead.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        // Keep a console trail for diagnostics; the UI shows a friendly message.
        console.error('Unhandled render error:', error, info.componentStack);
    }

    handleReload = () => {
        window.location.reload();
    };

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        return (
            <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface p-8 text-center">
                <span className="material-symbols-outlined text-error" style={{ fontSize: '40px' }} aria-hidden="true">
                    error
                </span>
                <h1 className="font-headline-md text-headline-md text-on-surface">Something went wrong</h1>
                <p className="max-w-md font-body-md text-body-md text-on-surface-variant">
                    The app hit an unexpected error and couldn't render this view. Your saved sessions are safe — reloading usually fixes it.
                </p>
                {error.message && (
                    <pre className="max-w-md overflow-x-auto rounded-lg bg-surface-variant px-3 py-2 text-left font-mono text-xs text-on-surface-variant">
                        {error.message}
                    </pre>
                )}
                <button
                    type="button"
                    onClick={this.handleReload}
                    className="rounded-lg bg-primary px-6 py-2.5 font-label-lg text-label-lg text-on-primary transition-colors hover:bg-primary/90"
                >
                    Reload
                </button>
            </div>
        );
    }
}
