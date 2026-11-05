// +page.server.ts — "server side" in-process: reaches bun:sqlite directly.
// parent() in a server load sees only ancestors' SERVER data (kit scoping).
import { getNoteCount } from '../server.ts';

export async function load({ parent }) {
	const p = await parent();
	return {
		noteCount: getNoteCount(),
		psv: p.user ?? 'none', // universal layout data — invisible to server parent()
		psrv: p.serverUser ?? 'none', // server layout data — visible
	};
}
