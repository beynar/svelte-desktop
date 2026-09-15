// server load calling event.fetch — handleFetch intercepts /api/who,
// /api/time resolves to the real +server.ts endpoint in-process.
export async function load({ fetch }) {
	const r = await fetch('/api/who');
	const t = await fetch('/api/time');
	return { who: (await r.json()).from, time: (await t.json()).from };
}
