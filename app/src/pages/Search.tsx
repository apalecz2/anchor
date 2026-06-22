import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { DeleteSessionDialog } from '../features/sessions/DeleteSessionDialog';
import { getDb } from '../lib/db';
import Icon from '../components/Icon';
import { formatSqliteTimestamp, escapeLike } from './searchUtils';

interface Session {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

const ITEMS_PER_PAGE = 10;

export default function Search(): React.ReactElement {
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [results, setResults] = useState<Session[]>([]);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [isLoading, setIsLoading] = useState(false);
    const [refreshToken, setRefreshToken] = useState(0);
    const [sessionToDelete, setSessionToDelete] = useState<Session | null>(null);

    // 1. Debounce the search input
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedQuery(query);
            setPage(1); // Reset to first page on new search
        }, 300);
        return () => clearTimeout(timer);
    }, [query]);

    // 2. Fetch data when query or page changes
    useEffect(() => {
        let isMounted = true;

        const fetchResults = async () => {
            setIsLoading(true);
            try {
                const db = await getDb();
                const searchTerm = `%${escapeLike(debouncedQuery)}%`;

                // Fetch total count for pagination
                const countRes = await db.select<{ count: number }[]>(
                    `SELECT COUNT(*) as count FROM sessions WHERE title LIKE $1 ESCAPE '\\'`,
                    [searchTerm]
                );
                
                const totalItems = countRes[0]?.count || 0;
                const calculatedTotalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));

                // Clamp the requested page into range and fetch *that* page's results
                // directly. Returning early on an out-of-range page (e.g. after the
                // result set shrank) would leave the previous, now-stale results on
                // screen until a follow-up render — so fetch the clamped page now and
                // sync the page state to match.
                const safePage = Math.min(page, calculatedTotalPages);
                const offset = (safePage - 1) * ITEMS_PER_PAGE;

                // Fetch paginated results
                const items = await db.select<Session[]>(
                    `SELECT * FROM sessions WHERE title LIKE $1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
                    [searchTerm, ITEMS_PER_PAGE, offset]
                );

                if (isMounted) {
                    setResults(items);
                    setTotalPages(calculatedTotalPages);
                    if (safePage !== page) setPage(safePage);
                }
            } catch (error) {
                console.error("Failed to fetch search results:", error);
            } finally {
                if (isMounted) setIsLoading(false);
            }
        };

        fetchResults();

        return () => {
            isMounted = false;
        };
    }, [debouncedQuery, page, refreshToken]);

    return (
        <main className="relative flex h-full flex-col overflow-hidden bg-background px-6 pb-10 pt-18 md:px-10">
            {/* Centered Content Wrapper */}
            <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
                
                <div className="mb-8 space-y-4">
                    <h1 className="text-3xl font-bold text-primary">Search</h1>
                    
                    {/* Search Input */}
                    <div className="relative flex w-full items-center">
                        <Icon name="search" size={24} className="absolute left-4 text-on-surface-variant" />
                        <input
                            type="text"
                            placeholder="Search extractions..."
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            className="h-12 w-full rounded-[10px] bg-surface-variant pl-12 pr-4 text-on-surface shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 placeholder:text-on-surface-variant/70"
                        />
                    </div>
                </div>

                {/* Results List */}
                <div className="flex-1 overflow-y-auto pb-4 pr-2">
                    {isLoading ? (
                        <div className="flex items-center text-on-surface-variant">
                            <Icon name="refresh" className="mr-2 animate-spin" />
                            Searching...
                        </div>
                    ) : results.length > 0 ? (
                        <div className="flex flex-col gap-3">
                            {results.map((session) => (
                                <div
                                    key={session.id}
                                    className="group flex items-stretch overflow-hidden rounded-[10px] border border-surface-variant bg-surface-container/50 transition-all duration-300 ease-out hover:bg-surface-variant"
                                >
                                    <Link
                                        to={`/session/${session.id}`}
                                        className="flex min-w-0 flex-1 flex-col justify-center p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/20"
                                    >
                                        <span className="truncate text-lg font-medium text-on-surface transition-colors group-hover:text-primary">
                                            {session.title}
                                        </span>
                                        <span className="mt-1 text-sm text-on-surface-variant">
                                            Last updated: {formatSqliteTimestamp(session.updated_at)}
                                        </span>
                                    </Link>

                                    <button
                                        type="button"
                                        onClick={() => setSessionToDelete(session)}
                                        className="flex shrink-0 items-center gap-2 border-l border-surface-variant bg-surface-container px-4 text-sm font-medium text-on-surface-variant transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/20"
                                        aria-label={`Delete session ${session.title}`}
                                    >
                                        <Icon name="delete" size={18} />
                                        Delete
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-on-surface-variant">
                            No results found for "{debouncedQuery}".
                        </div>
                    )}
                </div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                    <div className="mt-6 flex w-full items-center justify-between border-t border-surface-variant pt-4">
                        <button
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page === 1}
                            className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-surface-variant px-4 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:pointer-events-none disabled:opacity-50"
                        >
                            <Icon name="arrow_back" size={18} />
                            Previous
                        </button>
                        
                        <span className="text-sm text-on-surface-variant">
                            Page {page} of {totalPages}
                        </span>

                        <button
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                            className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-surface-variant px-4 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:pointer-events-none disabled:opacity-50"
                        >
                            Next
                            <Icon name="arrow_forward" size={18} />
                        </button>
                    </div>
                )}
            </div>

            <DeleteSessionDialog
                session={sessionToDelete ? { id: sessionToDelete.id, name: sessionToDelete.title } : null}
                onClose={() => setSessionToDelete(null)}
                onDeleted={() => setRefreshToken((current) => current + 1)}
            />
        </main>
    );
}