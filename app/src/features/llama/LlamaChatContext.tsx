import { createContext, useEffect, useRef, type ReactNode } from "react";

import { stopLlamaServer } from "./llamaClient.ts";

/**
 * Owns when the model is *released*, not when it is started.
 *
 * The pipeline executor in Rust decides which model a step needs and starts it —
 * it is the only side that knows the launch identity, so it is the only side that
 * can decide whether a running server is the right one. What stays here is the
 * complementary half: keeping the model warm for a short window after a job, so a
 * re-extract or the next page skips a multi-GB reload, then unloading it so an idle
 * session doesn't hold RAM (design §6).
 *
 * This lives in a provider rather than a module singleton because the warm window is
 * scoped to the Session route: leaving the session unloads the model immediately.
 */
type LlamaChatContextValue = {
    /** Unload now. */
    stopServer: () => Promise<void>;
    /** Release after a job: stay warm for a short idle window, then unload. A
     *  subsequent release resets the timer rather than stacking another. */
    releaseServer: () => void;
};

export const LlamaChatContext = createContext<LlamaChatContextValue | null>(null);

// How long to keep the model resident after a job finishes. Long enough that a
// user tweaking and re-extracting doesn't reload (tens of seconds for a 2.7 GB
// GGUF), short enough that an idle session releases its RAM (design §6).
const IDLE_UNLOAD_MS = 90_000;

export const LlamaChatProvider = ({ children }: { children: ReactNode }) => {
    const idleUnloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const cancelIdleUnload = () => {
        if (idleUnloadRef.current !== null) {
            clearTimeout(idleUnloadRef.current);
            idleUnloadRef.current = null;
        }
    };

    // Leaving the session frees the model outright — no reason to hold multiple GB
    // for a page the user has navigated away from.
    useEffect(() => {
        return () => {
            cancelIdleUnload();
            void stopLlamaServer();
        };
    }, []);

    const stopServer = async () => {
        cancelIdleUnload();
        await stopLlamaServer();
    };

    const releaseServer = () => {
        cancelIdleUnload();
        idleUnloadRef.current = setTimeout(() => {
            idleUnloadRef.current = null;
            void stopServer();
        }, IDLE_UNLOAD_MS);
    };

    return (
        <LlamaChatContext.Provider value={{ stopServer, releaseServer }}>
            {children}
        </LlamaChatContext.Provider>
    );
};
