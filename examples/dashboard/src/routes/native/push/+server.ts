// Server code pushing to the open sockets (a remote function or a job's callback would do the same).
import { sockets } from '@svelte-desktop/shell/websocket';
import { presence } from '../../../lib/server/presence';

export function POST() {
	const sent = sockets.publish('lobby', { type: 'push', text: `from the server at ${new Date().toLocaleTimeString()}` });
	return Response.json({ sent, subscribers: sockets.subscribers('lobby'), online: presence.online });
}
