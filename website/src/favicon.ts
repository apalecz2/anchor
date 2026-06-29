import { ANCHOR_PATH } from './components/AnchorMark';

/* ─────────────────────────────────────────────────────────────────────────
   Runtime favicon painter.

   The static /favicon.svg uses a `prefers-color-scheme` media query, which
   tracks the OS theme. But the page theme can be overridden by the in-app
   toggle, so the OS-driven favicon would desync from the page whenever a
   visitor picks a theme different from their system setting.

   To keep them locked together, we repaint the favicon from the page's own
   resolved theme — the `dark` class on <html> — and observe that class so
   every change (toggle click or live system change) updates the tab icon too.
   The bare anchor glyph mirrors the page's anchor colour: ink in light, paper
   in dark.
   ───────────────────────────────────────────────────────────────────────── */

const INK = '#16202E';
const PAPER = '#F3F1EA';

function faviconHref(isDark: boolean): string {
    const fill = isDark ? PAPER : INK;
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960">` +
        `<path fill="${fill}" d="${ANCHOR_PATH}"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Replace the SVG favicon link with one coloured for the given theme. We
 *  recreate the node (rather than only setting href) because some browsers
 *  won't repaint the tab icon on an in-place href change. PNG fallbacks in
 *  index.html are left untouched for browsers without SVG-favicon support. */
function paintFavicon(isDark: boolean): void {
    document.querySelectorAll('link[rel~="icon"][type="image/svg+xml"]').forEach((n) => n.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = faviconHref(isDark);
    document.head.appendChild(link);
}

/** Keep the favicon in sync with the page theme for the life of the page.
 *  Returns a teardown that disconnects the observer. */
export function syncFaviconToTheme(): () => void {
    const root = document.documentElement;
    const update = () => paintFavicon(root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
}
