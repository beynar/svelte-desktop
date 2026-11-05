import { CONFORMANCE_SECRET } from '$app/env/private';
import { serverOnly } from '#lib/server/secret';

export function load({ locals, url, setHeaders }) {
	setHeaders({ 'x-load-header': 'set' });
	return {
		server: 'from +page.server.ts',
		serverOnly,
		hookRan: locals.hookRan,
		query: url.searchParams.get('q'),
		env: CONFORMANCE_SECRET,
		// Not awaited: streamed to the client after the HTML.
		streamed: new Promise<string>((r) => setTimeout(() => r('streamed value'), 300))
	};
}
