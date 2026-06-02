import { getDb } from '../../lib/db';
import { emitSessionChange } from './sessionEvents';

export async function deleteSession(sessionId: string): Promise<void> {
    const db = await getDb();

    await db.execute('DELETE FROM sessions WHERE id = $1', [sessionId]);
    emitSessionChange({ deletedSessionId: sessionId });
}