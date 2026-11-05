import { command, form, getRequestEvent, prerender, query } from '$app/server';

let bumps = 0;

export const greet = query('unchecked', async (name: string) => `hello ${name}`);

export const double = query.batch('unchecked', async (ns: number[]) => {
	const calls = ns.length;
	return (n: number) => ({ value: n * 2, batchSize: calls });
});

export const bumped = query(async () => bumps);

export const bump = command('unchecked', async (by: number) => {
	bumps += by;
	await bumped().refresh();
	return bumps;
});

export const rename = form('unchecked', async (data) => {
	const name = String((data as { name?: string }).name ?? '');
	if (!name) return { error: 'empty' };
	getRequestEvent().cookies.set('remote-name', name, { path: '/' });
	return { renamed: name };
});

export const whoami = query(async () => getRequestEvent().cookies.get('remote-name') ?? null);

export const buildInfo = prerender(async () => ({ prerendered: true }));

export const slow = command('unchecked', async (ms: number) => {
	await new Promise((r) => setTimeout(r, ms));
	return ms;
});
