// Drives background jobs from tests: POST {name, args, concurrency} → start, GET → list
// (or ?id= / &wait=1), DELETE ?id= → cancel.
import { json } from '@sveltejs/kit';

export async function POST({ request }: { request: Request }) {
	const { name, args, concurrency } = await request.json();
	return json(host.jobs.start(name, args, { concurrency }));
}

export async function GET({ url }: { url: URL }) {
	const id = url.searchParams.get('id');
	if (!id) return json(host.jobs.list());
	if (url.searchParams.get('wait')) return json(await host.jobs.wait(id));
	return json(host.jobs.get(id));
}

export function DELETE({ url }: { url: URL }) {
	return json({ canceled: host.jobs.cancel(url.searchParams.get('id') ?? '') });
}
