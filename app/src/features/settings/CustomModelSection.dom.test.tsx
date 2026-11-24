import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const open = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a: unknown[]) => open(...a) }));

import CustomModelSection from './CustomModelSection';

const registered = {
    weightsPath: '/home/a/models/mistral-7b-instruct-Q4_K_M.gguf',
    ctx: 8192,
    weightsBytes: 4_100_000_000,
};

beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_custom_model') return Promise.resolve(null);
        return Promise.resolve(undefined);
    });
});

describe('CustomModelSection', () => {
    it('warns that a supplied model is unverified whether or not one is chosen', async () => {
        // The warning is the point of the section, not a footnote on one state of it:
        // before a choice it is what the user is agreeing to, after one it is why a
        // bad result may not be a bug.
        const { unmount } = render(<CustomModelSection />);
        await waitFor(() => expect(screen.getByText(/not verified/i)).toBeTruthy());
        expect(screen.getByText(/known fingerprint/i)).toBeTruthy();
        unmount();

        invoke.mockImplementation((cmd: string) =>
            Promise.resolve(cmd === 'get_custom_model' ? registered : undefined));
        render(<CustomModelSection />);
        await waitFor(() => expect(screen.getByText(/not verified/i)).toBeTruthy());
    });

    it('shows the registered model by name and size', async () => {
        invoke.mockImplementation((cmd: string) =>
            Promise.resolve(cmd === 'get_custom_model' ? registered : undefined));
        render(<CustomModelSection />);

        await waitFor(() =>
            expect(screen.getByText('mistral-7b-instruct-Q4_K_M.gguf')).toBeTruthy());
        expect(screen.getByText(/4\.1 GB/)).toBeTruthy();
    });

    it('registers the picked file through the backend, which does the validating', async () => {
        open.mockResolvedValue('/home/a/models/new.gguf');
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_custom_model') return Promise.resolve(null);
            if (cmd === 'set_custom_model') {
                return Promise.resolve({ ...registered, weightsPath: '/home/a/models/new.gguf' });
            }
            return Promise.resolve(undefined);
        });
        render(<CustomModelSection />);

        fireEvent.click(await screen.findByText(/Choose a model file/));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('set_custom_model', {
                weightsPath: '/home/a/models/new.gguf',
                ctx: 8192,
            }));
        expect(await screen.findByText('new.gguf')).toBeTruthy();
    });

    /**
     * The backend's message names which check failed — missing file, wrong extension,
     * not actually a GGUF. Replacing it with a generic failure turns a fixable mistake
     * into a mystery, so it is surfaced verbatim.
     */
    it('surfaces the backend\'s rejection verbatim', async () => {
        open.mockResolvedValue('/home/a/models/not-really.gguf');
        invoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_custom_model') return Promise.resolve(null);
            if (cmd === 'set_custom_model') {
                return Promise.reject('That file is not a GGUF model — its contents do not match the format, whatever the name says.');
            }
            return Promise.resolve(undefined);
        });
        render(<CustomModelSection />);

        fireEvent.click(await screen.findByText(/Choose a model file/));
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('not a GGUF model');
    });

    it('does nothing when the file dialog is dismissed', async () => {
        open.mockResolvedValue(null);
        render(<CustomModelSection />);

        fireEvent.click(await screen.findByText(/Choose a model file/));
        await waitFor(() => expect(open).toHaveBeenCalled());
        expect(invoke).not.toHaveBeenCalledWith('set_custom_model', expect.anything());
    });

    it('lets the user go back to the built-in model', async () => {
        invoke.mockImplementation((cmd: string) =>
            Promise.resolve(cmd === 'get_custom_model' ? registered : undefined));
        render(<CustomModelSection />);

        fireEvent.click(await screen.findByText(/Use the built-in model/));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('clear_custom_model'));
        expect(await screen.findByText(/Choose a model file/)).toBeTruthy();
    });

    it('treats an unreadable registration as "none chosen" rather than breaking', async () => {
        invoke.mockImplementation((cmd: string) =>
            cmd === 'get_custom_model'
                ? Promise.reject('could not read')
                : Promise.resolve(undefined));
        render(<CustomModelSection />);
        expect(await screen.findByText(/Choose a model file/)).toBeTruthy();
    });
});
