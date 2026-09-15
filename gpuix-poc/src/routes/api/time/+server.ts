// +server.ts endpoint — fetch('/api/time') inside a load resolves here
// in-process, before handleFetch/real-fetch fallthrough.
export function GET({ url, locals, cookies, getClientAddress }) {
	// endpoints get the full RequestEvent — cookies/locals/client address
	return Response.json({
		from: 'endpoint',
		user: locals.user ?? null,
		session: cookies.get('session') ?? 'none',
		ip: getClientAddress(),
	});
}

export async function POST({ request }) {
	return Response.json({ method: request.method, body: await request.text() });
}
