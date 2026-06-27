# Anchor — companion landing page

A standalone marketing/landing site for **Anchor**, the local-first AI data
extraction desktop app. Built with the same stack and theme as the app
(React 19 + TypeScript + Tailwind v4) so it stays visually identical to the
product.

## What's reused from the app

- **Theme tokens** — [`src/theme.css`](src/theme.css) copies the Material-3-style
  palette, type scale (Source Serif 4 / Inter), and dark-mode variables verbatim
  from `app/src/App.css`.
- **`Icon` component** — [`src/components/Icon.tsx`](src/components/Icon.tsx) is a
  direct copy of the app's Material Symbols icon wrapper.
- **Layout language** — the hero, feature cards, step rows, format badges, and
  tech-stack table mirror the app's `About.tsx` page.

## Develop

```bash
cd website
npm install
npm run dev      # http://localhost:5173
```

## Build (static output)

```bash
npm run build    # type-checks, then emits to website/dist/
npm run preview  # serve the production build locally
```

`dist/` is plain static HTML/CSS/JS — host it anywhere (GitHub Pages, Cloudflare
Pages, Netlify, R2 + a CDN, etc.).

## Before publishing

Edit the `LINKS` constant at the top of [`src/App.tsx`](src/App.tsx):

| Key | Purpose |
|---|---|
| `github` | Public repository URL |
| `releases` | GitHub Releases page — the Windows download (Phase 1) |
| `microsoftStore` | Store listing URL — leave empty to show "Coming soon" (Phase 3) |
| `macDownload` | macOS DMG URL — leave empty until shipped (Phase 4) |

Empty download links automatically render as a disabled **Coming soon** button,
matching the rollout sequence in [`docs/release-strategy.md`](../docs/release-strategy.md).
