import { FC, useEffect, useState } from 'react';
import { Link } from 'react-router';
import ConfirmDialog from './ConfirmDialog';
import { deleteSession } from '../features/sessions/sessionActions';

// ─── Nav Item Definition ───────────────────────────────────────────────────────
// Add, remove, or reorder items here to change the sidebar contents.
export interface NavItem {
    /** Unique identifier used as the React key */
    id: string;
    /** Material Symbols icon name (see fonts.google.com/icons) */
    icon: string;
    /** Display label shown when the sidebar is expanded */
    label: string;
    /** Optional: href for anchor-based navigation */
    href?: string;
    /** Optional: click handler (takes priority over href) */
    onClick?: () => void;
}

export const defaultNavItems: NavItem[] = [
    { id: 'dashboard', icon: 'add', label: 'New Extraction', href: '/' },
    { id: 'search', icon: 'search', label: 'Search', href: '/search' },
    { id: 'settings', icon: 'settings', label: 'Settings', href: '/settings' },
    { id: 'about', icon: 'info', label: 'About', href: '/about' },
];

// ─── Component Props ───────────────────────────────────────────────────────────
interface SideNavBarProps {
    collapsed: boolean;
    onToggleCollapse: () => void;
    /** Override the default nav items with your own list */
    navItems?: NavItem[];
    /** Optionally highlight one item as active */
    activeId?: string;
    recentItems?: NavItem[];
}

const SideNavBar: FC<SideNavBarProps> = ({
    collapsed,
    onToggleCollapse,
    navItems = defaultNavItems,
    activeId,
    recentItems = [],
}) => {
    const [recentContextMenu, setRecentContextMenu] = useState<{
        x: number;
        y: number;
        item: NavItem;
    } | null>(null);
    const [sessionToDelete, setSessionToDelete] = useState<NavItem | null>(null);

    useEffect(() => {
        if (!recentContextMenu) {
            return;
        }

        const closeMenu = () => setRecentContextMenu(null);

        window.addEventListener('click', closeMenu);
        window.addEventListener('resize', closeMenu);
        window.addEventListener('scroll', closeMenu, true);

        return () => {
            window.removeEventListener('click', closeMenu);
            window.removeEventListener('resize', closeMenu);
            window.removeEventListener('scroll', closeMenu, true);
        };
    }, [recentContextMenu]);

    const handleDeleteRecentSession = async () => {
        if (!sessionToDelete?.href) {
            return;
        }

        const sessionId = sessionToDelete.href.replace('/session/', '');

        try {
            await deleteSession(sessionId);
        } catch (error) {
            console.error('Failed to delete recent session:', error);
        } finally {
            setSessionToDelete(null);
        }
    };

    return (
        <>
            {/* Optional: Mobile overlay backdrop when expanded */}
            {!collapsed && (
                <div
                    className="fixed inset-0 z-30 bg-transparent transition-opacity md:hidden"
                    onClick={onToggleCollapse}
                    aria-hidden="true"
                />
            )}

            {/* 1. Moved Button */}
            <button
                onClick={onToggleCollapse}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className={`
                        fixed top-4 z-50 flex h-10 w-10 items-center justify-center rounded-[10px] bg-surface-variant text-on-surface shadow-md transition-all duration-300 ease-out hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20
                    ${collapsed
                        ? 'left-4 md:left-8 md:-translate-x-1/2' // Mobile: top-left. Desktop: centered over 5.5rem.
                        : 'left-60' // Expanded: 18rem width minus button width & padding
                    }
                `}
            >
                <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 0" }}>
                    {collapsed ? 'menu' : 'chevron_left'}
                </span>
            </button>

            {/* Sidebar Container */}
            <aside
                className={`
                    fixed top-0 left-0 z-40 flex h-screen flex-col border-r border-surface-variant bg-surface-container transition-all duration-300 ease-out
                    ${collapsed
                        ? '-translate-x-full md:translate-x-0 md:w-16' // Hidden on mobile, narrow on desktop
                        : 'translate-x-0 w-[18rem]' // Expanded state
                    }
                `}
            >
                <Link
                    to="/"
                    className={`
                        absolute top-4 left-6 flex h-10 items-center overflow-hidden whitespace-nowrap transition-all duration-300
                        ${collapsed ? 'w-0 opacity-0 pointer-events-none' : 'w-48 opacity-100'}
                    `}
                    aria-hidden={collapsed}
                    tabIndex={collapsed ? -1 : 0}
                >
                    <span className="text-2xl font-bold text-on-surface hover:opacity-80 transition-opacity">
                        Artifact
                    </span>
                </Link>

                <nav
                    className="mt-20 flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-4"
                    aria-label="Main navigation"
                >
                    {/*
                     * Main items never shrink (shrink-0): they always keep their full
                     * height even when the window is squished vertically.
                     */}
                    <div className="flex shrink-0 flex-col gap-2">
                    {navItems.map((item) => {
                        const isActive = item.id === activeId;

                        const content = (
                            <>
                                {/* Icon — always visible, centered in collapsed state */}
                                <span
                                    className="material-symbols-outlined flex min-w-[24px] justify-center text-[24px]"
                                    style={{
                                        fontVariationSettings: isActive
                                            ? "'FILL' 1"
                                            : "'FILL' 0",
                                    }}
                                    aria-hidden="true"
                                >
                                    {item.icon}
                                </span>

                                {/*
                                 * Label visibility rules:
                                 *   - Mobile  : always hidden (sidebar is off-screen when collapsed)
                                 *   - Desktop collapsed : hidden (md:opacity-0 + md:w-0 prevents layout shift)
                                 *   - Desktop expanded  : visible
                                 *   - Any expanded      : visible
                                 */}
                                <span
                                    className={`
                                        flex-1 truncate text-sm font-medium
                                        transition-[opacity,width,margin] duration-300
                                        ${collapsed
                                            ? 'w-0 opacity-0 md:ml-0 ml-4' // Removes margin on desktop collapsed, keeps it on mobile
                                            : 'opacity-100 ml-4' // Standard margin when expanded
                                        }
                                    `}
                                >
                                    {item.label}
                                </span>
                            </>
                        );

                        const sharedClassName = `
                            flex h-10 w-full shrink-0 cursor-pointer items-center rounded-[10px]
                            transition-all duration-300 ease-out overflow-hidden
                            ${collapsed ? 'md:px-2 px-3' : 'px-3'}
                            ${isActive
                                ? 'bg-primary/10 text-primary'
                                : 'text-on-surface hover:bg-surface-variant'
                            }
                        `;

                        // Render as <a> when href is provided, otherwise <button>
                        if (item.href && !item.onClick) {
                            return (
                                <Link
                                    key={item.id}
                                    to={item.href}
                                    className={sharedClassName}
                                    aria-current={isActive ? 'page' : undefined}
                                    title={collapsed ? item.label : undefined}
                                >
                                    {content}
                                </Link>
                            );
                        }

                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={item.onClick}
                                className={sharedClassName}
                                aria-current={isActive ? 'page' : undefined}
                                title={collapsed ? item.label : undefined}
                            >
                                {content}
                            </button>
                        );
                    })}
                    </div>

                    {/*
                     * Recent sessions live in their own flex region (min-h-0 flex-1) so
                     * the list scrolls instead of squashing the rows. The whole region
                     * collapses when there's too little vertical room, sacrificing the
                     * recent list to preserve the main items above.
                     */}
                    {recentItems.length > 0 && !collapsed && (
                        <div className="mt-2 flex min-h-0 flex-1 flex-col">
                            <div className={`
                            my-2 shrink-0 border-t border-surface-variant transition-opacity duration-300
                            ${collapsed ? 'mx-2 opacity-50' : 'mx-4 opacity-100'}
                        `} />

                            <div className={`
                            mb-1 min-w-56 shrink-0 whitespace-nowrap text-sm font-semibold text-on-surface-variant transition-all duration-300
                            ${collapsed ? 'w-0 overflow-hidden opacity-0' : 'ml-3 opacity-100'}
                        `}>
                                Recent Sessions
                            </div>

                            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto">
                            {recentItems.map((item) => {
                                const isActive = item.id === activeId;

                                const content = (
                                    <span className="min-w-56 truncate text-sm font-medium">
                                        {item.label}
                                    </span>
                                );

                                const sharedClassName = `
                                    flex h-10 w-full shrink-0 cursor-pointer items-center rounded-[10px]
                                    transition-all duration-300 ease-out overflow-hidden
                                    ${collapsed ? 'md:px-2 px-3' : 'px-3'}
                                    ${isActive
                                        ? 'bg-primary/10 text-primary'
                                        : 'text-on-surface hover:bg-surface-variant'
                                    }
                                `;

                                if (item.href && !item.onClick) {
                                    return (
                                        <Link
                                            key={item.id}
                                            to={item.href}
                                            className={sharedClassName}
                                            aria-current={isActive ? 'page' : undefined}
                                            title={collapsed ? item.label : undefined}
                                            onContextMenu={(event) => {
                                                event.preventDefault();
                                                setRecentContextMenu({
                                                    x: event.clientX,
                                                    y: event.clientY,
                                                    item,
                                                });
                                            }}
                                        >
                                            {content}
                                        </Link>
                                    );
                                }

                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={item.onClick}
                                        className={sharedClassName}
                                        aria-current={isActive ? 'page' : undefined}
                                        title={collapsed ? item.label : undefined}
                                    >
                                        {content}
                                    </button>
                                );
                            })}
                            </div>
                        </div>
                    )}

                </nav>

                {recentContextMenu && (
                    <>
                        <div
                            className="fixed inset-0 z-40 bg-transparent"
                            onClick={() => setRecentContextMenu(null)}
                            aria-hidden="true"
                        />
                        <div
                            className="fixed z-50 w-48 overflow-hidden rounded-[14px] border border-outline-variant bg-surface-bright p-1 shadow-2xl"
                            style={{ left: recentContextMenu.x, top: recentContextMenu.y }}
                            role="menu"
                            aria-label={`Actions for ${recentContextMenu.item.label}`}
                        >
                            <button
                                type="button"
                                className="flex w-full items-center rounded-[10px] px-3 py-2 text-left text-sm font-medium text-error transition-colors hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/20"
                                onClick={() => {
                                    setSessionToDelete(recentContextMenu.item);
                                    setRecentContextMenu(null);
                                }}
                            >
                                Delete session
                            </button>
                        </div>
                    </>
                )}
            </aside>

            <ConfirmDialog
                open={sessionToDelete !== null}
                title="Delete session?"
                description={
                    sessionToDelete
                        ? `This will permanently delete "${sessionToDelete.label}" and all related files, outputs, and OCR data.`
                        : ''
                }
                confirmLabel="Delete"
                onConfirm={handleDeleteRecentSession}
                onCancel={() => setSessionToDelete(null)}
            />
        </>
    );
};

export default SideNavBar;