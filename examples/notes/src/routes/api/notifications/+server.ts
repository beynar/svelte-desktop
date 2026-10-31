// Notification responses seen by server code: every click/action/reply/dismiss of the app,
// including one that launched it (events wait for their first listener).
import { json } from '@sveltejs/kit';

const seen: { kind: string; id: string; actionId: string | null }[] = [];
host.notifications.on('response', (e) => seen.push({ kind: e.kind, id: e.id, actionId: e.actionId }));

export const GET = () => json(seen);
