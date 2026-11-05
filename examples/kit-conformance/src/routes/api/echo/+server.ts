import { json } from '@sveltejs/kit';

export function GET({ url, request, cookies, setHeaders }) {
	setHeaders({ 'x-echo': 'yes' });
	return json({ query: Object.fromEntries(url.searchParams), method: 'GET', visitor: cookies.get('visitor') ?? null, ua: request.headers.get('user-agent') ? 'present' : 'absent', origin: url.origin, protocol: url.protocol });
}

export async function POST({ request, cookies }) {
	const body = await request.json();
	cookies.set('visitor', String(body.visitor ?? 'anon'), { path: '/' });
	return json({ method: 'POST', body }, { status: 201 });
}
