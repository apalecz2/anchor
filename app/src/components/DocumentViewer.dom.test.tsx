import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DocumentViewer from './DocumentViewer';
import { maxZoomFor } from './documentZoom';
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
    // jsdom has no matchMedia, and useTheme (which the page shadow reads) consults
    // it whenever no explicit theme is stored.
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
    }));
});

/**
 * jsdom reports every element as 0x0, so the viewer's fit math (which needs a
 * live pane size) never engages. Give the pane a size for the tests that care.
 * Applied to the prototype because the measurement happens in a mount effect,
 * before `render` has handed back anything to set it on.
 */
function stubPaneSize(width: number, height: number) {
    for (const [prop, value] of [['clientWidth', width], ['clientHeight', height]] as const) {
        Object.defineProperty(HTMLElement.prototype, prop, { value, configurable: true });
    }
}

function renderViewer(
    props: Partial<React.ComponentProps<typeof DocumentViewer>> = {},
    natural = { width: 800, height: 600 },
) {
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
            zoom={1}
            onZoomChange={vi.fn()}
            {...props}
        />,
    );
    // The SVG (and word rects) only render once the image reports its natural size.
    const img = utils.container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: natural.width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: natural.height, configurable: true });
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
        // Default precision is exact: a solid, filled outline around the source words.
        const highlight = container.querySelectorAll('svg rect')[2];
        expect(highlight.getAttribute('stroke-dasharray')).toBeNull();
        expect(highlight.getAttribute('class')).toContain('fill-');
        expect(highlight.querySelector('title')).toBeNull();
    });

    it('draws a coarse highlight as an unfilled dashed outline that says so', () => {
        // A block-grounded page knows only the region a value sits in. Drawing that as
        // the confident solid box used for exact word bounds would be a claim the
        // grounding never made — it would point at an area and say "this is the value".
        const { container } = renderViewer({
            provenanceHighlightBox: { left: 5, top: 5, width: 30, height: 10 },
            highlightPrecision: 'coarse',
        });
        const highlight = container.querySelectorAll('svg rect')[2];
        expect(highlight.getAttribute('stroke-dasharray')).toBe('8 6');
        expect(highlight.getAttribute('class')).toContain('fill-none');
        expect(highlight.querySelector('title')?.textContent).toMatch(/Approximate location/);
    });
});

describe('DocumentViewer zoom ceiling', () => {
    afterEach(() => {
        for (const prop of ['clientWidth', 'clientHeight']) {
            Reflect.deleteProperty(HTMLElement.prototype, prop);
        }
    });

    /** A full-page scan in a split pane: 2000px of render, ~500px to show it in. */
    const renderScan = (props: Partial<React.ComponentProps<typeof DocumentViewer>> = {}) => {
        stubPaneSize(500, 500);
        return renderViewer(props, { width: 2000, height: 2600 });
    };

    it('reports the fit scale so the toolbar can derive the ceiling and the readout', () => {
        const onFitScaleChange = vi.fn();
        renderScan({ onFitScaleChange });

        const fitScale = onFitScaleChange.mock.calls.at(-1)?.[0] as number;
        // (500 - 2*16) / 2600 — height-bound for a portrait page.
        expect(fitScale).toBeCloseTo(468 / 2600, 10);
        // The point of reporting it: the ceiling it implies is well past the old
        // fixed 2, and lands exactly on the source resolution.
        expect(maxZoomFor(fitScale)).toBeGreaterThan(5);
        expect(maxZoomFor(fitScale) * fitScale).toBeCloseTo(1, 10);
    });

    it('renders past the old fixed ceiling of 2, up to 1:1', () => {
        const fitScale = 468 / 2600;
        const { container } = renderScan({ zoom: maxZoomFor(fitScale) });

        // The transformed wrapper carries the composed scale; at the ceiling the
        // image is drawn at its natural size, which is the whole fix.
        const wrapper = container.querySelector('[style*="translate"]') as HTMLElement;
        const rendered = Number(/scale\(([\d.]+)\)/.exec(wrapper.style.transform)?.[1]);
        expect(rendered).toBeCloseTo(1, 10);
    });

    it('pulls a zoom above the ceiling back down instead of rendering it clamped', () => {
        // The ceiling moves with the pane (divider drag, window resize), so a
        // zoom can outlive the fit that allowed it. Left alone, the toolbar would
        // keep showing — and stepping from — a value the viewer refuses to honour.
        const onZoomChange = vi.fn();
        renderScan({ zoom: 50, onZoomChange });

        expect(onZoomChange).toHaveBeenCalledWith(maxZoomFor(468 / 2600));
    });
});
