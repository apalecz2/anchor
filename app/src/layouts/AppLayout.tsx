import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import SideNavBar, { NavItem } from '../components/SideNavBar';
import { useLocation, useNavigate } from 'react-router';
import { getDb } from '../lib/db';
import { subscribeToSessionChanges } from '../features/sessions/sessionEvents';
import { useTheme } from '../hooks/useTheme';
import Icon from '../components/Icon';

interface SessionRow {
    id: string;
    title: string;
}

async function loadRecentSessions(): Promise<NavItem[]> {
    const db = await getDb();

    const sessions = await db.select<SessionRow[]>(
        'SELECT id, title FROM sessions ORDER BY updated_at DESC LIMIT 10'
    );

    return sessions.map((session) => ({
        id: session.id,
        icon: 'description',
        label: session.title,
        href: `/session/${session.id}`,
    }));
}

export default function AppLayout() {
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

    const location = useLocation();
    const navigate = useNavigate();
    const [recentSessions, setRecentSessions] = useState<NavItem[]>([]);

    const activeId = location.pathname === '/'
        ? 'dashboard'
        : location.pathname.split('/').pop();

    const [theme, setTheme] = useTheme();
    const isDarkMode = theme === 'dark';

    // The session page has its own floating toolbars in the top-right area, so the
    // theme toggle is hidden there to avoid overlapping/competing controls.
    const isSessionPage = location.pathname.startsWith('/session/');

    useEffect(() => {
        let isActive = true;

        async function fetchRecents() {
            try {
                const sessions = await loadRecentSessions();

                if (isActive) {
                    setRecentSessions(sessions);
                }
            } catch (error) {
                console.error("Failed to fetch recent sessions:", error);
            }
        }
        
        fetchRecents();

        return () => {
            isActive = false;
        };
    }, [location.pathname]);

    useEffect(() => {
        return subscribeToSessionChanges(({ deletedSessionId, allDeleted }) => {
            void (async () => {
                try {
                    const sessions = await loadRecentSessions();
                    setRecentSessions(sessions);
                } catch (error) {
                    console.error('Failed to refresh recent sessions:', error);
                }
            })();

            const onDeletedSession =
                deletedSessionId && location.pathname === `/session/${deletedSessionId}`;
            const onAnySession = allDeleted && location.pathname.startsWith('/session/');
            if (onDeletedSession || onAnySession) {
                navigate('/search', { replace: true });
            }
        });
    }, [location.pathname, navigate]);

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
                {!isSessionPage && (
                    <div className="absolute top-4 right-6 z-50">
                        <button
                            aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                            className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-surface-variant text-on-surface transition-colors shadow-md hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                            onClick={() => setTheme(isDarkMode ? 'light' : 'dark')}
                            type="button"
                        >
                            <Icon name={isDarkMode ? 'dark_mode' : 'light_mode'} size={20} fill={0} />
                        </button>
                    </div>
                )}

                {/* Dynamic Page Content injects here. Keying on the path remounts the
                    page on navigation (resetting per-page/session state cleanly); the
                    fade-in smooths that swap so it doesn't flash. */}
                <div key={location.pathname} className="flex-1 overflow-hidden animate-fade-in">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}