import { FC } from 'react';
import { Link } from 'react-router';

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
                    className="mt-20 flex flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-3 pb-4"
                    aria-label="Main navigation"
                >
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
                            flex h-10 w-full cursor-pointer items-center rounded-[10px]
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

                    {recentItems.length > 0 && (
                        <>
                            <div className={`
                            my-2 border-t border-surface-variant transition-opacity duration-300
                            ${collapsed ? 'mx-2 opacity-50' : 'mx-4 opacity-100'}
                        `} />

                            <div className={`
                            mb-1 text-xs font-semibold text-on-surface-variant transition-all duration-300
                            ${collapsed ? 'w-0 overflow-hidden opacity-0' : 'ml-4 opacity-100'}
                        `}>
                                Recent Sessions
                            </div>

                            {recentItems.map((item) => {
                                const isActive = item.id === activeId;

                                const content = (
                                    <>
                                        <span
                                            className="material-symbols-outlined flex min-w-[24px] justify-center text-[24px]"
                                            style={{
                                                fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0",
                                            }}
                                            aria-hidden="true"
                                        >
                                            {item.icon}
                                        </span>
                                        <span
                                            className={`
                                                flex-1 truncate text-sm font-medium
                                                transition-[opacity,width,margin] duration-300
                                                ${collapsed
                                                    ? 'w-0 opacity-0 md:ml-0 ml-4'
                                                    : 'opacity-100 ml-4'
                                                }
                                            `}
                                        >
                                            {item.label}
                                        </span>
                                    </>
                                );

                                const sharedClassName = `
                                    flex h-10 w-full cursor-pointer items-center rounded-[10px]
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
                        </>
                    )}

                </nav>
            </aside>
        </>
    );
};

export default SideNavBar;