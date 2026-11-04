// A stand-in OAuth provider for the demo: its own little server (the system browser can't open the
// app's pages, they need the app's session cookie), an "Approve / Deny" page, a token endpoint that
// checks the PKCE verifier. A real app uses GitHub, Google… instead.
const codes = new Map<string, string>(); // code → PKCE challenge

let server: ReturnType<typeof Bun.serve> | undefined;
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (body: string) =>
	new Response(`<!doctype html><meta charset="utf-8"><title>Demo provider</title><style>body{font:15px system-ui;display:grid;place-items:center;min-height:90vh}main{text-align:center}a{display:inline-block;margin:.5rem;padding:.6rem 1.2rem;border-radius:8px;background:#5f62ef;color:#fff;text-decoration:none}a.deny{background:#a1a1aa}</style><main>${body}</main>`, {
		headers: { 'content-type': 'text/html; charset=utf-8' }
	});

export function demoProvider(): string {
	server ??= Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/authorize') {
				// Like a real provider: only the registered redirect (an app's loopback callback, any port).
				let redirect: URL;
				try {
					redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
				} catch {
					return new Response('invalid redirect_uri', { status: 400 });
				}
				if (!['127.0.0.1', 'localhost'].includes(redirect.hostname) || redirect.pathname !== '/__desktop/oauth/callback') return new Response('redirect_uri not registered', { status: 400 });
				const back = (params: Record<string, string>) => {
					const to = new URL(url.searchParams.get('redirect_uri')!);
					for (const [k, v] of Object.entries({ ...params, state: url.searchParams.get('state')! })) to.searchParams.set(k, v);
					return to.href;
				};
				const code = crypto.randomUUID();
				codes.set(code, url.searchParams.get('code_challenge') ?? '');
				return page(`<h1>Demo provider</h1><p><strong>${escape(url.searchParams.get('client_id') ?? '')}</strong> wants to read your profile.</p>
<a href="${escape(back({ code }))}">Approve as Ada</a><a class="deny" href="${escape(back({ error: 'access_denied', error_description: 'You denied the request' }))}">Deny</a>`);
			}
			if (url.pathname === '/token' && req.method === 'POST') {
				const form = new URLSearchParams(await req.text());
				const challenge = codes.get(form.get('code') ?? '');
				codes.delete(form.get('code') ?? '');
				const proof = new Bun.CryptoHasher('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
				const cors = { 'access-control-allow-origin': '*' };
				if (!challenge || proof !== challenge) return Response.json({ error: 'invalid_grant', error_description: 'bad code or verifier' }, { status: 400, headers: cors });
				return Response.json({ access_token: `demo-${crypto.randomUUID().slice(0, 8)}`, token_type: 'bearer', scope: 'profile', user: 'Ada' }, { headers: cors });
			}
			if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
			return new Response('not found', { status: 404 });
		}
	});
	return `http://127.0.0.1:${server.port}`;
}
