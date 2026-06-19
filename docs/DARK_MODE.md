# Dark / Light Mode Implementation

How dark and light mode work in this project (Artifact, `app/`). The theme is a
class on `<html>` plus a set of CSS custom properties that the Tailwind tokens read
from, with a single shared hook keeping every toggle in sync.

## Key files

- **[app/src/App.css](../app/src/App.css)** — defines the `dark` Tailwind variant, the Material-style color tokens (light in `:root`, dark in `html.dark`), and maps them to Tailwind via `@theme`.
- **[app/src/hooks/useTheme.ts](../app/src/hooks/useTheme.ts)** — the single source of truth: resolves, persists, applies, and broadcasts the theme.
- **[app/src/lib/settings.ts](../app/src/lib/settings.ts)** — typed `localStorage` wrapper; the `theme` key (`'light' | 'dark'`) lives here.
- **[app/src/layouts/AppLayout.tsx](../app/src/layouts/AppLayout.tsx)** and **[app/src/pages/Settings.tsx](../app/src/pages/Settings.tsx)** — the two user-facing toggles (header icon + Settings page), both driven by `useTheme`.

There is **no inline bootstrap script** in `index.html`; the theme is applied from React via `useTheme` on mount.

## How it works

- Dark mode is a **`dark` class on `document.documentElement`** (`<html>`). Tailwind's `dark:` variant is remapped from its default `prefers-color-scheme` media query to that class:

  ```css
  /* app/src/App.css */
  @custom-variant dark (&:where(.dark, .dark *));
  ```

  So `class="bg-surface dark:bg-surface-container-low"` switches purely on the presence of `.dark`.

- **Colors are CSS custom properties**, defined twice — light values under `:root`, dark values under `html.dark` — and exposed to Tailwind as `--color-*` tokens in the `@theme` block. Components only ever use the semantic Tailwind classes (`bg-surface`, `text-on-surface`, `border-outline-variant`, `text-primary`, …); switching themes just re-points the underlying variables, so no component needs theme-specific code.

  ```css
  :root        { color-scheme: light; --surface: #faf9f7; --on-surface: #1a1c1b; /* … */ }
  html.dark    { color-scheme: dark;  --surface: #131313; --on-surface: #e5e2e1; /* … */ }
  ```

- **Resolution order** (`resolveTheme` in `useTheme.ts`): an explicit stored choice (`localStorage.theme === 'dark' | 'light'`) wins; otherwise it follows the OS via `window.matchMedia('(prefers-color-scheme: dark)')`.

- **Single writer + sync.** `setTheme(theme)` persists to `localStorage`, toggles the `.dark` class, and dispatches a `dataextractionai:theme-changed` `CustomEvent`. Every `useTheme()` subscriber listens for that event and re-renders, so the header icon and the Settings toggle never disagree (they previously each held their own `useState` and could drift).

  ```ts
  // app/src/hooks/useTheme.ts
  export function setTheme(theme: Theme): void {
      writeSetting('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
      window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGE_EVENT, { detail: theme }));
  }
  ```

## Reusing this pattern in another project

1. Map the `dark:` variant to a class: `@custom-variant dark (&:where(.dark, .dark *));` (Tailwind 4).
2. Define semantic color tokens twice — defaults under `:root`, overrides under `html.dark` (or your chosen class) — and expose them via `@theme` as `--color-*`.
3. Use only the semantic classes (`bg-surface`, `text-on-surface`, …) in components, never hardcoded colors, so a theme switch is purely variable overrides.
4. Centralize read/write/apply/broadcast in one module (here `useTheme.ts`) so multiple toggles stay in sync; persist the choice to `localStorage`.
5. Default to the system preference (`prefers-color-scheme`) when nothing is stored.

## Notes

- Because the theme is applied by React on mount rather than an inline `<head>` script, a brief flash of the default theme is possible on cold load; add an inline bootstrap script in `index.html` if you need to eliminate it.
- Give each toggle an accessible label (e.g. `aria-label="Toggle dark mode"`) and ensure both palettes meet WCAG AA contrast.
