// hooks — kit-shaped; in-process equivalents.
import { getRequestEvent } from '#kit';
import { Money } from './money.ts';

export const state = { handled: 0, errors: [], errRoute: null, greInHandle: false };

export async function init() {
	state.handled = 0;
}

export async function handle({ event, resolve }) {
	state.handled++;
	// getRequestEvent() must work inside handle — kit scopes hooks in ALS
	state.greInHandle = getRequestEvent() === event;
	event.locals.user = 'from-hook';
	return resolve(event);
}

export function handleError(input) {
	state.errors.push(String(input.error?.message ?? input.error));
	state.errRoute = input.event?.route?.id ?? null;
}

// intercepts fetch() calls made inside load functions
export async function handleFetch({ request, fetch }) {
	// kit hands handleFetch a real Request
	if (!(request instanceof Request)) throw new Error('handleFetch request is not a Request');
	if (String(request.url).endsWith('/api/who')) {
		return new Response(JSON.stringify({ from: 'handleFetch' }), {
			headers: { 'content-type': 'application/json' },
		});
	}
	return fetch(request);
}

// kit reroute — map a url to a different route id (i18n/legacy paths)
export function reroute({ url }) {
	if (url.pathname === '/legacy') return '/about';
}

// kit transport — custom classes crossing the server→client boundary
export const transport = {
	Money: {
		encode: (v) => (v instanceof Money ? [v.cents] : false),
		decode: ([c]) => new Money(c),
	},
};
