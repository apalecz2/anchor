import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DocumentViewer from './DocumentViewer';
import { ocrWord, resetFixtureIds } from '../test/fixtures';

// Word with a non-trivial box, matching this spec's earlier fixed-box usage.
const word = (text: string) => ocrWord(text, 10, 10, 20, 12);

// jsdom doesn't implement SVG geometry; stub createSVGPoint + getScreenCTM so
// getSvgPoint maps clientX/Y through an identity transform (enough to exercise the
// draw-box threshold and rounding without a real layout).
beforeAll(() => {
    // @ts-expect-error augmenting jsdom's SVGSVGElement
    SVGSVGElement.prototype.createSVGPoint = function () {
        return {
            x: 0,
            y: 0,
            matrixTransform() {
                return { x: this.x, y: this.y };
            },
        };
    };
    // @ts-expect-error augmenting jsdom's SVGSVGElement
    SVGSVGElement.prototype.getScreenCTM = function () {
        return { inverse: () => ({}) };
    };
});

function renderViewer(props: Partial<React.ComponentProps<typeof DocumentViewer>> = {}) {
    const onAddWord = vi.fn();
    const onWordClick = vi.fn();
    const onEditRequest = vi.fn();
    const onDeleteRequest = vi.fn();
    const setHighlightedWordId = vi.fn();
    const words = props.words ?? [word('Hello'), word('World')];
    const utils = render(
        <DocumentViewer
            fileUrl="asset://doc.png"
            words={words}
            onAddWord={onAddWord}
            onEditRequest={onEditRequest}
            onDeleteRequest={onDeleteRequest}
            highlightedWordId={null}
            setHighlightedWordId={setHighlightedWordId}
            onWordClick={onWordClick}
            activeTool="draw"
            transform={{ scale: 1, x: 0, y: 0 }}
            setTransform={vi.fn()}
            {...props}
        />,
    );
    // The SVG (and word rects) only render once the image reports its natural size.
    const img = utils.container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    fireEvent.load(img);
    return { ...utils, onAddWord, onWordClick, onEditRequest, onDeleteRequest, setHighlightedWordId, words };
}

beforeEach(() => {
    resetFixtureIds();
});

describe('DocumentViewer', () => {
    it('renders a rect per OCR word once the image has loaded', () => {
        const { container, words } = renderViewer();
        const wordRects = container.querySelectorAll('svg rect');
        expect(wordRects.length).toBe(words.length);
    });

    it('fires onWordClick when a word rect is clicked', () => {
        const { container, onWordClick, words } = renderViewer();
        fireEvent.click(container.querySelector('svg rect')!);
        expect(onWordClick).toHaveBeenCalledWith(words[0].id);
    });

    it('sets and clears the highlighted word on hover', () => {
        const { container, setHighlightedWordId, words } = renderViewer();
        const rect = container.querySelector('svg rect')!;
        fireEvent.mouseEnter(rect);
        expect(setHighlightedWordId).toHaveBeenCalledWith(words[0].id);
        fireEvent.mouseLeave(rect);
        expect(setHighlightedWordId).toHaveBeenCalledWith(null);
    });

    it('opens a context menu whose Edit/Delete fire their callbacks', () => {
        const { container, onEditRequest, onDeleteRequest, words } = renderViewer();
        fireEvent.contextMenu(container.querySelector('svg rect')!);
        fireEvent.click(screen.getByText('Edit Text'));
        expect(onEditRequest).toHaveBeenCalledWith(words[0].id, words[0].text);

        fireEvent.contextMenu(container.querySelector('svg rect')!);
        fireEvent.click(screen.getByText('Delete Word'));
        expect(onDeleteRequest).toHaveBeenCalledWith(words[0].id);
    });

    it('draws a box larger than 5px and calls onAddWord with rounded coords', () => {
        const { container, onAddWord } = renderViewer();
        const svg = container.querySelector('svg')!;
        fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.mouseMove(svg, { clientX: 20, clientY: 14 });
        fireEvent.mouseUp(svg);
        expect(onAddWord).toHaveBeenCalledWith({ left: 0, top: 0, width: 20, height: 14 });
    });

    it('ignores a draw smaller than the 5px threshold', () => {
        const { container, onAddWord } = renderViewer();
        const svg = container.querySelector('svg')!;
        fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.mouseMove(svg, { clientX: 3, clientY: 3 });
        fireEvent.mouseUp(svg);
        expect(onAddWord).not.toHaveBeenCalled();
    });

    it('renders the provenance highlight box when provided', () => {
        const { container } = renderViewer({
            provenanceHighlightBox: { left: 5, top: 5, width: 30, height: 10 },
        });
        // words + 1 provenance highlight rect
        expect(container.querySelectorAll('svg rect').length).toBe(3);
    });
});
