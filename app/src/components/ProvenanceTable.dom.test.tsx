import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProvenanceTable from './ProvenanceTable';
import type { TrustLevel, AgreementStatus, ProvenanceCell } from '../features/extraction/types';
import { provenanceCell } from '../test/fixtures';

const cell = (
    value: string,
    trust: TrustLevel,
    over: { agreement?: AgreementStatus; matchStatus?: ProvenanceCell['matchStatus'] } = {},
) => provenanceCell(value, { trust, ...over });

describe('ProvenanceTable', () => {
    it('renders nothing for empty rows', () => {
        const { container } = render(
            <ProvenanceTable rows={[]} onCellClick={vi.fn()} selectedCell={null} />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('renders header and data rows', () => {
        const rows = [
            [cell('Name', 'high'), cell('Score', 'high')],
            [cell('Alice', 'high'), cell('90', 'medium')],
        ];
        render(<ProvenanceTable rows={rows} onCellClick={vi.fn()} selectedCell={null} />);
        expect(screen.getByRole('columnheader', { name: /Name/ })).toBeInTheDocument();
        expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('maps trust levels to background colour classes', () => {
        const rows = [
            [cell('H', 'high')],
            [cell('M', 'medium')],
            [cell('L', 'low')],
        ];
        render(<ProvenanceTable rows={rows} onCellClick={vi.fn()} selectedCell={null} />);
        expect(screen.getByText('H').closest('th')!.className).toContain('bg-green');
        expect(screen.getByText('M').closest('td')!.className).toContain('bg-amber');
        expect(screen.getByText('L').closest('td')!.className).toContain('bg-red');
    });

    it('shows a gray cell and ? badge for image-only cells (M14)', () => {
        const rows = [[cell('X', 'low', { agreement: 'image_only', matchStatus: 'unmatched' })]];
        render(<ProvenanceTable rows={rows} onCellClick={vi.fn()} selectedCell={null} />);
        const th = screen.getByText('X').closest('th')!;
        expect(th.className).toContain('bg-surface-variant');
        expect(th.textContent).toContain('?');
    });

    it('shows the ≈ badge for fuzzy cells', () => {
        const rows = [
            [cell('H', 'high')],
            [cell('approx', 'medium', { matchStatus: 'fuzzy' })],
        ];
        render(<ProvenanceTable rows={rows} onCellClick={vi.fn()} selectedCell={null} />);
        expect(screen.getByText('approx').closest('td')!.textContent).toContain('≈');
    });

    it('header cells get trust colours, not a flat gray', () => {
        const rows = [[cell('Header', 'high')], [cell('data', 'high')]];
        render(<ProvenanceTable rows={rows} onCellClick={vi.fn()} selectedCell={null} />);
        expect(screen.getByText('Header').closest('th')!.className).toContain('bg-green');
    });

    it('fires onCellClick for both header and data cells', () => {
        const onCellClick = vi.fn();
        const rows = [[cell('Head', 'high')], [cell('Body', 'high')]];
        render(<ProvenanceTable rows={rows} onCellClick={onCellClick} selectedCell={null} />);
        fireEvent.click(screen.getByText('Head'));
        fireEvent.click(screen.getByText('Body'));
        expect(onCellClick).toHaveBeenCalledTimes(2);
    });

    it('adds a selection ring and scrolls the selected cell into view', () => {
        const rows = [[cell('A', 'high'), cell('B', 'high')]];
        render(
            <ProvenanceTable
                rows={rows}
                onCellClick={vi.fn()}
                selectedCell={{ rowIndex: 0, colIndex: 1 }}
            />,
        );
        expect(screen.getByText('B').closest('th')!.className).toContain('ring-2');
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
});
