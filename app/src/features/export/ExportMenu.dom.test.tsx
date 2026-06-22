import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ExportMenu } from './ExportMenu';
import * as exportUtils from './exportUtils';
import type { ProvenanceCell } from '../extraction/types';
import { mockClipboard } from '../../test/helpers';
import { provenanceCell as provCell } from '../../test/fixtures';

// Keep the real serializers, but spy on the dialog-driven save so we never touch
// the Tauri fs/dialog plugins.
vi.mock('./exportUtils', async () => {
    const actual = await vi.importActual<typeof import('./exportUtils')>('./exportUtils');
    return { ...actual, saveWithDialog: vi.fn().mockResolvedValue(true) };
});

const rows: ProvenanceCell[][] = [[provCell('Name'), provCell('Age')], [provCell('Al'), provCell('30')]];

describe('ExportMenu', () => {
    beforeEach(() => vi.useRealTimers());

    it('is disabled when there is no data', () => {
        render(<ExportMenu provenanceCells={null} savedCsv={null} fileStem="x" />);
        expect(screen.getByRole('button', { name: /Export/ })).toBeDisabled();
    });

    it('toggles the menu open and closed', () => {
        render(<ExportMenu provenanceCells={rows} savedCsv={null} fileStem="x" />);
        const trigger = screen.getByRole('button', { name: /Export/ });
        fireEvent.click(trigger);
        expect(screen.getByText('CSV')).toBeInTheDocument();
        fireEvent.click(trigger);
        expect(screen.queryByText('CSV')).not.toBeInTheDocument();
    });

    it('closes on outside mousedown', () => {
        render(<ExportMenu provenanceCells={rows} savedCsv={null} fileStem="x" />);
        fireEvent.click(screen.getByRole('button', { name: /Export/ }));
        expect(screen.getByText('CSV')).toBeInTheDocument();
        fireEvent.mouseDown(document.body);
        expect(screen.queryByText('CSV')).not.toBeInTheDocument();
    });

    it('saves each format with its serializer and SaveFormat', async () => {
        render(<ExportMenu provenanceCells={rows} savedCsv={null} fileStem="report" />);
        fireEvent.click(screen.getByRole('button', { name: /Export/ }));
        fireEvent.click(screen.getByText('CSV'));
        await waitFor(() =>
            expect(exportUtils.saveWithDialog).toHaveBeenCalledWith(
                'report',
                exportUtils.toCsv([['Name', 'Age'], ['Al', '30']]),
                expect.objectContaining({ ext: 'csv' }),
            ),
        );
    });

    it('prefers provenance rows over savedCsv', async () => {
        render(<ExportMenu provenanceCells={rows} savedCsv={'ignored,csv\n1,2'} fileStem="r" />);
        fireEvent.click(screen.getByRole('button', { name: /Export/ }));
        fireEvent.click(screen.getByText('CSV'));
        await waitFor(() => {
            const content = (exportUtils.saveWithDialog as ReturnType<typeof vi.fn>).mock.calls[0][1];
            expect(content).toContain('Name');
            expect(content).not.toContain('ignored');
        });
    });

    it('falls back to parsing savedCsv when there are no provenance rows', async () => {
        render(<ExportMenu provenanceCells={null} savedCsv={'a,b\n1,2'} fileStem="r" />);
        fireEvent.click(screen.getByRole('button', { name: /Export/ }));
        fireEvent.click(screen.getByText('CSV'));
        await waitFor(() => {
            const content = (exportUtils.saveWithDialog as ReturnType<typeof vi.fn>).mock.calls[0][1];
            expect(content).toBe(exportUtils.toCsv([['a', 'b'], ['1', '2']]));
        });
    });

    it('copies markdown to the clipboard and flips to "Copied!" then back', async () => {
        vi.useFakeTimers();
        const writeText = mockClipboard();
        render(<ExportMenu provenanceCells={rows} savedCsv={null} fileStem="x" />);
        fireEvent.click(screen.getByRole('button', { name: /Export/ }));
        fireEvent.click(screen.getByText('Copy table'));
        expect(writeText).toHaveBeenCalledWith(exportUtils.toMarkdown([['Name', 'Age'], ['Al', '30']]));
        // resolve the clipboard promise -> "Copied!"
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByText('Copied!')).toBeInTheDocument();
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
        vi.useRealTimers();
    });
});
