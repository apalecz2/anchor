export interface SessionChangeDetail {
    deletedSessionId?: string;
}

const SESSION_CHANGE_EVENT = 'dataextractionai:sessions-changed';

export function emitSessionChange(detail: SessionChangeDetail): void {
    if (typeof window === 'undefined') {
        return;
    }

    window.dispatchEvent(new CustomEvent<SessionChangeDetail>(SESSION_CHANGE_EVENT, { detail }));
}

export function subscribeToSessionChanges(
    listener: (detail: SessionChangeDetail) => void,
): () => void {
    if (typeof window === 'undefined') {
        return () => {};
    }

    const handleChange = (event: Event) => {
        listener((event as CustomEvent<SessionChangeDetail>).detail);
    };

    window.addEventListener(SESSION_CHANGE_EVENT, handleChange);

    return () => {
        window.removeEventListener(SESSION_CHANGE_EVENT, handleChange);
    };
}