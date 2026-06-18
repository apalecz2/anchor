import { remove } from '@tauri-apps/plugin-fs';
import { getDb, SESSION_CHILD_TABLES } from '../../lib/db';
import { emitSessionChange } from './sessionEvents';

export async function deleteSession(sessionId: string): Promise<void> {
    const db = await getDb();

    // Collect paths before the rows are deleted.
    const [uploadedFiles, generatedImages] = await Promise.all([
        db.select<{ file_path: string }[]>(
            'SELECT file_path FROM files WHERE session_id = $1',
            [sessionId]
        ),
        db.select<{ image_path: string }[]>(
            'SELECT image_path FROM document_pages WHERE session_id = $1',
            [sessionId]
        ),
    ]);

    // Delete child rows explicitly rather than trusting ON DELETE CASCADE: the
    // FK pragma is per-connection and the sqlx pool may run this on a connection
    // that never enabled it, which would orphan files/pages/outputs. Children
    // first, then the parent. DB delete precedes filesystem removal: if file
    // removal fails the UI is still correct (session gone); the reverse risks DB
    // records pointing at already-deleted files with no recovery path.
    for (const table of SESSION_CHILD_TABLES) {
        await db.execute(`DELETE FROM ${table} WHERE session_id = $1`, [sessionId]);
    }
    await db.execute('DELETE FROM sessions WHERE id = $1', [sessionId]);
    emitSessionChange({ deletedSessionId: sessionId });

    const uniquePaths = new Set([
        ...uploadedFiles.map(f => f.file_path),
        ...generatedImages.map(p => p.image_path),
    ]);

    // Best-effort -> a file that is already missing must not surface as an error.
    await Promise.allSettled([...uniquePaths].map(p => remove(p)));
}

// Deletes every session and its associated rows and files. Returns the number of
// sessions removed so callers can give feedback. Mirrors deleteSession's ordering
// (children before parents, DB before filesystem) but clears the tables wholesale.
export async function deleteAllSessions(): Promise<number> {
    const db = await getDb();

    // Collect every on-disk path before the rows are deleted.
    const [uploadedFiles, generatedImages, sessions] = await Promise.all([
        db.select<{ file_path: string }[]>('SELECT file_path FROM files'),
        db.select<{ image_path: string }[]>('SELECT image_path FROM document_pages'),
        db.select<{ id: string }[]>('SELECT id FROM sessions'),
    ]);

    // Children first, then parents — same reasoning as deleteSession: we don't
    // trust ON DELETE CASCADE because the FK pragma is per-connection.
    for (const table of SESSION_CHILD_TABLES) {
        await db.execute(`DELETE FROM ${table}`);
    }
    await db.execute('DELETE FROM sessions');
    emitSessionChange({ allDeleted: true });

    const uniquePaths = new Set([
        ...uploadedFiles.map(f => f.file_path),
        ...generatedImages.map(p => p.image_path),
    ]);

    // Best-effort -> a file that is already missing must not surface as an error.
    await Promise.allSettled([...uniquePaths].map(p => remove(p)));

    return sessions.length;
}