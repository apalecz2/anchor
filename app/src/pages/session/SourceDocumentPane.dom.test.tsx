import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SourceDocumentPane } from './SourceDocumentPane';
import type { DocumentPageResult } from '../../features/extraction/types';

// A page that failed to render: the toolbar (page navigation, zoom) still shows
// — deliberately, so navigation stays available — but no DocumentViewer mounts,
// which keeps this test off jsdom's missing SVG/canvas geometry.
const erroredPage: DocumentPageResult = {
    image_path: '',
    natural_width: 0,
    natural_height: 0,
    words: [],
    text: '',
    error: 'render failed',
};

function renderPane(over: { totalPages?: number; activePageIndex?: number } = {}) {
    const goToPage = vi.fn();
    const setPageInputValue = vi.fn();
    const activePageIndex = over.activePageIndex ?? 4;
    const totalPages = over.totalPages ?? 5;

    // The input's value is a controlled prop owned by Session, so the harness has
    // to hold it for real — a bare spy would leave the box showing its initial
    // value and every commit would parse that instead of what was typed.
    function Harness() {
        const [pageInputValue, setValue] = useState(String(activePageIndex + 1));
        return (
        <SourceDocumentPane
            isDbLoading={false}
            showProcessing={false}
            processProgress={null}
            processingCancelled={false}
            dbError={null}
            cancelProcessing={vi.fn()}
            retryProcessing={vi.fn()}
            fileUrl={null}
            activePage={erroredPage}
            viewerRef={{ current: null }}
            addWord={vi.fn()}
            editWord={vi.fn()}
            deleteWord={vi.fn()}
            editingState={null}
            setEditingState={vi.fn()}
            highlightedWordId={null}
            setHighlightedWordId={vi.fn()}
            onWordClick={vi.fn()}
            provenanceHighlightBox={null}
            highlightPrecision="exact"
            activeTool="pan"
            setActiveTool={vi.fn()}
            zoom={1}
            setZoom={vi.fn()}
            overlayMode="all"
            setOverlayMode={vi.fn()}
            totalPages={totalPages}
            activePageIndex={activePageIndex}
            goToPage={goToPage}
            pageInputValue={pageInputValue}
            setPageInputValue={(next: string) => { setPageInputValue(next); setValue(next); }}
        />
        );
    }

    const view = render(<Harness />);
    return { ...view, goToPage, setPageInputValue, activePageIndex };
}

/** Type a page number and commit it the way Enter does (blur). */
const commit = (value: string) => {
    const input = screen.getByLabelText('Page number');
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
};

describe('SourceDocumentPane page input', () => {
    /**
     * The regression: the box was only resynced by an effect keyed on
     * `activePageIndex`, so an entry that clamped to the page already showing
     * changed nothing — and "99" sat in the box indefinitely, describing a page
     * the document does not have.
     */
    it('rewrites an out-of-range entry even when the page does not change', () => {
        const { setPageInputValue, goToPage } = renderPane({ activePageIndex: 4, totalPages: 5 });
        commit('99');

        expect(setPageInputValue).toHaveBeenLastCalledWith('5');
        expect(goToPage).not.toHaveBeenCalled();
    });

    it('clamps at the bottom too', () => {
        const { setPageInputValue, goToPage } = renderPane({ activePageIndex: 0, totalPages: 5 });
        commit('0');

        expect(setPageInputValue).toHaveBeenLastCalledWith('1');
        expect(goToPage).not.toHaveBeenCalled();
    });

    it('navigates on an in-range entry', () => {
        const { setPageInputValue, goToPage } = renderPane({ activePageIndex: 4, totalPages: 5 });
        commit('2');

        expect(goToPage).toHaveBeenCalledWith(1);
        expect(setPageInputValue).toHaveBeenLastCalledWith('2');
    });

    it('restores the current page when the entry is not a number', () => {
        const { setPageInputValue, goToPage } = renderPane({ activePageIndex: 2, totalPages: 5 });
        commit('abc');

        expect(setPageInputValue).toHaveBeenLastCalledWith('3');
        expect(goToPage).not.toHaveBeenCalled();
    });
});
