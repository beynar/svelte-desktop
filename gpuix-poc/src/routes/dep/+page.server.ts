// exercises event.fetch: endpoint resolution, Request passthrough
// (method+body preserved), endpoint error() → Response, and the
// fetch-url invalidation channel (invalidate('/api/time') reruns this).
let runs = 0;

export async function load({ fetch }) {
	runs++;
	const t = await fetch('/api/time');
	const tj = await t.json();
	const post = await fetch('/api/time', { method: 'POST', body: 'hi-body' });
	const fail = await fetch('/api/fail'); // endpoint throws error(418)
	return {
		runs,
		time: tj.from,
		session: tj.session ?? 'none',
		post: (await post.json()).body,
		fail: fail.status,
	};
}
