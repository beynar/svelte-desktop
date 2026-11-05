import type { Handle, HandleServerError } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.hookRan = true;
	const res = await resolve(event, { transformPageChunk: ({ html }) => html.replace('%conformance%', 'transformed') });
	res.headers.set('x-conformance-hook', '1');
	return res;
};

// SvelteKit 3: every caught error comes through with its `kind`; rewrite only unexpected ones.
export const handleError: HandleServerError = ({ kind, error }) =>
	kind === 'unknown' ? { message: `handled: ${(error as Error).message}` } : undefined;
