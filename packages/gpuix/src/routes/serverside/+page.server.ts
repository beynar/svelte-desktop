import { getRequestEvent, read } from '#kit';

let loads = 0;

export async function load(event) {
	loads++;
	// $app/server surface inside a load
	const ev = getRequestEvent();
	const hooksText = await (await read('src/hooks.ts')).text();
	return {
		session: event.cookies.get('session') ?? 'none',
		ip: event.getClientAddress(),
		evUser: ev.locals.user,
		readOk: hooksText.includes('handle') ? 'handle' : 'miss',
		loads,
	};
}

export const actions = {
	setcookie: async ({ cookies }) => {
		cookies.set('session', 'abc');
		return { ok: true };
	},
};
