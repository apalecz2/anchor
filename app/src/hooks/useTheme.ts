import { useEffect, useState } from 'react';
import { readSetting, writeSetting, type Theme } from '../lib/settings';

// Theme lives in localStorage, but two independent controls flip it — the header
// icon in AppLayout and the toggle in the Settings page. Each used to hold its own
// useState, so changing one left the other's React state stale and the controls
// visibly disagreed. This module makes the theme a single shared source: every
// setTheme() persists, applies to the DOM, and broadcasts to all subscribers so
// they re-render together.
const THEME_CHANGE_EVENT = 'dataextractionai:theme-changed';

// Resolve the effective theme: an explicit stored choice wins, otherwise follow the
// OS preference. Mirrors the original inline logic in AppLayout/Settings.
export function resolveTheme(): Theme {
    if (typeof window === 'undefined') return readSetting('theme');
    const stored = window.localStorage.getItem('theme');
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Single writer for theme: persist, apply to the DOM, then notify every useTheme
// subscriber so independent toggles stay in sync.
export function setTheme(theme: Theme): void {
    writeSetting('theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGE_EVENT, { detail: theme }));
    }
}

export function useTheme(): [Theme, (theme: Theme) => void] {
    const [theme, setLocal] = useState<Theme>(resolveTheme);

    // Keep the DOM class in sync on mount (covers first load) and on any change.
    useEffect(() => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
    }, [theme]);

    useEffect(() => {
        const onChange = (event: Event) => setLocal((event as CustomEvent<Theme>).detail);
        window.addEventListener(THEME_CHANGE_EVENT, onChange);
        return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    }, []);

    return [theme, setTheme];
}
