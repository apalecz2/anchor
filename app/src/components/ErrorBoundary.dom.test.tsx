import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

function Boom({ message }: { message: string }): React.ReactElement {
    throw new Error(message);
}

describe('ErrorBoundary', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        // React logs the caught error; silence it to keep test output clean.
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => errorSpy.mockRestore());

    it('renders children when healthy', () => {
        render(
            <ErrorBoundary>
                <div>Healthy child</div>
            </ErrorBoundary>,
        );
        expect(screen.getByText('Healthy child')).toBeInTheDocument();
    });

    it('renders the fallback with the error message when a child throws', () => {
        render(
            <ErrorBoundary>
                <Boom message="stale provenance row" />
            </ErrorBoundary>,
        );
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
        expect(screen.getByText('stale provenance row')).toBeInTheDocument();
    });

    it('Reload calls window.location.reload (L11)', () => {
        const reload = vi.fn();
        // jsdom's location.reload throws "not implemented"; replace it.
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { ...window.location, reload },
        });
        render(
            <ErrorBoundary>
                <Boom message="x" />
            </ErrorBoundary>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
