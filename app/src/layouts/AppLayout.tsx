import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import SideNavBar, { NavItem } from '../components/SideNavBar';
import { useLocation } from 'react-router';
import { getDb } from '../lib/db';

interface SessionRow {
    id: string;
    title: string;
}

export default function AppLayout() {
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

    const location = useLocation();
    const [recentSessions, setRecentSessions] = useState<NavItem[]>([]);

    const activeId = location.pathname === '/'
        ? 'dashboard'
        : location.pathname.split('/').pop();

    const [isDarkMode, setIsDarkMode] = useState(() => {
        if (typeof window === 'undefined') {
            return false;
        }

        const storedTheme = window.localStorage.getItem('theme');

        if (storedTheme === 'dark') {
            return true;
        }

        if (storedTheme === 'light') {
            return false;
        }

        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    });

    useEffect(() => {
        document.documentElement.classList.toggle('dark', isDarkMode);
        window.localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    }, [isDarkMode]);

    useEffect(() => {
        async function fetchRecents() {
            try {
                const db = await getDb();
                
                // Use raw SQL to fetch the latest 10 sessions
                const sessions = await db.select<SessionRow[]>(
                    'SELECT id, title FROM sessions ORDER BY updated_at DESC LIMIT 10'
                );

                setRecentSessions(sessions.map(s => ({
                    id: s.id,
                    icon: 'description', // Or any material symbol you prefer
                    label: s.title,
                    href: `/session/${s.id}`
                })));
            } catch (error) {
                console.error("Failed to fetch recent sessions:", error);
            }
        }
        
        fetchRecents();
    }, [location.pathname]);

    return (
        <div className="bg-background text-on-surface font-body-md antialiased overflow-hidden flex h-screen w-full">

            <SideNavBar
                collapsed={isSidebarCollapsed}
                onToggleCollapse={() => setIsSidebarCollapsed((current) => !current)}
                activeId={activeId}
                recentItems={recentSessions}
            />

            {/* Main Content Area */}
            <main
                className={`flex-1 flex flex-col relative transition-all duration-300 ease-out ml-0 
                    ${isSidebarCollapsed ? 'md:ml-16' : 'md:ml-[18rem]'}`}
            >

                {/* === Top Right Floating Button === */}
                <div className="absolute top-4 right-6 z-50">
                    <button
                        aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                        className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-surface-variant text-on-surface transition-colors shadow-md hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                        onClick={() => setIsDarkMode((current) => !current)}
                        type="button"
                    >
                        <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 0" }}>
                            {isDarkMode ? 'dark_mode' : 'light_mode'}
                        </span>
                    </button>
                </div>

                {/* Dynamic Page Content injects here */}
                <div className="flex-1 overflow-hidden">
                    <Outlet key={location.pathname} />
                </div>
            </main>
        </div>
    );
}