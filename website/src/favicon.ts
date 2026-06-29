import { ANCHOR_PATH } from './components/AnchorMark';

/* ─────────────────────────────────────────────────────────────────────────
   Runtime favicon painter.

   The favicon lives in the browser's tab strip, which is painted by the
   browser chrome following the OS / browser theme — NOT the page theme. The
   in-app toggle can put the page in a theme that differs from the system, so
   if the bare-glyph favicon tracked the page it could end up the same colour
   as the tab strip and vanish.

   To stay visible, the favicon always contrasts with the *system* theme:
   ink anchor on a light tab strip, paper anchor on a dark one. We drive it
   from `prefers-color-scheme` and repaint on system-theme changes so it keeps
   up live, independent of whatever theme the page is currently showing.
   ───────────────────────────────────────────────────────────────────────── */

const INK = '#16202E';
const PAPER = '#F3F1EA';

function faviconHref(systemDark: boolean): string {
    // Dark tab strip → paper glyph; light tab strip → ink glyph.
    const fill = systemDark ? PAPER : INK;
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960">` +
        `<path fill="${fill}" d="${ANCHOR_PATH}"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Replace the SVG favicon link with one coloured for the given system theme.
 *  We recreate the node (rather than only setting href) because some browsers
 *  won't repaint the tab icon on an in-place href change. PNG fallbacks in
 *  index.html are left untouched for browsers without SVG-favicon support. */
function paintFavicon(systemDark: boolean): void {
    document.querySelectorAll('link[rel~="icon"][type="image/svg+xml"]').forEach((n) => n.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = faviconHref(systemDark);
    document.head.appendChild(link);
}

/** Keep the favicon contrasting with the OS / browser theme for the life of
 *  the page. Returns a teardown that removes the listener. */
export function syncFaviconToSystemTheme(): () => void {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => paintFavicon(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
}
