import { remove } from '@tauri-apps/plugin-fs';
import { getDb } from '../../lib/db';
import { emitSessionChange } from './sessionEvents';

export async function deleteSession(sessionId: string): Promise<void> {
    const db = await getDb();

    // Collect paths before the cascade wipes the rows.
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

    // DB delete before filesystem: if file removal fails the UI is still
    // correct (session gone). The reverse risks DB records pointing to
    // already-deleted files, which breaks re-processing with no recovery path.
    await db.execute('DELETE FROM sessions WHERE id = $1', [sessionId]);
    emitSessionChange({ deletedSessionId: sessionId });

    const uniquePaths = new Set([
        ...uploadedFiles.map(f => f.file_path),
        ...generatedImages.map(p => p.image_path),
    ]);

    // Best-effort -> a file that is already missing must not surface as an error.
    await Promise.allSettled([...uniquePaths].map(p => remove(p)));
}