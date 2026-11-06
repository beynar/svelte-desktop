// Sessions, proxies, custom schemes, content rules, registered scripts and the input policy on a real
// Windows runner: a server that sees which cookies each session sends and what a rule keeps from it,
// local proxies that see the requests, real resources from a real handler, real key presses.
//   WINDOWS_E2E=1 [WINDOWS_APP=<app folder>] bun test --timeout 120000 tests/windows-sessions.test.ts
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, type AppHandle } from '@kitop/shell/test';
import { APP, driver, log, ps, stopLeftovers, tmp, win } from './windows-input.ts';

const policyTest = readFileSync(resolve(import.meta.dir, '../../../packages/shell/test/platform/linux-web-policy.ts'), 'utf8');
const CERT = policyTest.match(/const CERT = `([\s\S]*?)`/)![1]!, KEY = policyTest.match(/const KEY = `([\s\S]*?)`/)![1]!;
const BIG = 8 * 1024 * 1024;

describe.skipIf(!process.env.WINDOWS_E2E)('windows: sessions and web content', () => {
	let app: AppHandle;
	const { op, code, check, until, inView } = driver(() => app);
	const s = <T = any>(name: string, args: Record<string, unknown> = {}, ms?: number) => op<T>('sessions', name, args, ms);
	const wv = <T = any>(name: string, args: Record<string, unknown> = {}, ms?: number) => op<T>('webview', name, args, ms);

	// A real server: what each request carried, and how many times each path was asked for.
	const hits = new Map<string, number>();
	const seen = new Map<string, string | null>();
	let server: ReturnType<typeof Bun.serve<{ path: string }, never>>;
	let site = '', other = '', own = '';
	const html = (body: string, headers: Record<string, string> = {}) => new Response(`<!doctype html><title>t</title>${body}`, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers } });

	// The scheme's handler (src/lib/server/protocol-probe.ts) waits on this and says what went away.
	const released = new Map<string, () => void>();
	const aborted: string[] = [];
	let control: ReturnType<typeof Bun.serve>;
	const release = (name: string) => released.get(name)?.();

	const closeView = (id: string) => op('view', 'destroy', { id }).catch(() => {});
	const openView = async (id: string, url: string, extra: Record<string, unknown> = {}) => {
		const loaded = app.nextEvent('viewLoaded', (e: { id: string }) => e.id === id, 30_000);
		await op('view', 'create', { id, windowId: 0, url, bounds: { x: 0, y: 0, width: 600, height: 400 }, ...extra });
		await loaded;
	};
	const go = async (id: string, url: string) => {
		const done = app.nextEvent('viewLoaded', (e: { id: string; url: string }) => e.id === id && e.url === url, 30_000);
		await op('view', 'navigate', { id, url });
		await done;
	};
	const cookieAt = async (id: string) => {
		seen.delete('/see');
		await inView(id, `fetch('/see?' + Math.random()).then(() => 1)`);
		return seen.get('/see') ?? '';
	};
	const untilText = (id: string, text: string, ms = 15_000) => until(`the page says ${text}`, async () => (await inView(id, `document.getElementById('p')?.textContent`)) === text, ms);
	const profileFolder = () => join(process.env.LOCALAPPDATA!, 'dev.kitop.notes', 'WebView2-sessions');

	beforeAll(async () => {
		await stopLeftovers();
		server = Bun.serve({
			hostname: '0.0.0.0',
			port: 0,
			idleTimeout: 60,
			fetch(req, srv) {
				const url = new URL(req.url), { pathname } = url;
				hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
				seen.set(pathname, req.headers.get('cookie'));
				if (pathname === '/socket') return srv.upgrade(req, { data: { path: pathname } }) ? undefined : new Response('no', { status: 400 });
				if (pathname === '/set') return html('set', { 'set-cookie': `who=${url.searchParams.get('who')}; Path=/; Max-Age=3600; HttpOnly` });
				if (pathname === '/ask') return new Response('asked', { status: 401, headers: { 'www-authenticate': 'Basic realm="a site"', 'content-type': 'text/plain' } });
				if (pathname === '/worker.js') return new Response(`fetch('/from-worker').then(() => postMessage('done'), () => postMessage('failed'))`, { headers: { 'content-type': 'text/javascript' } });
				if (pathname === '/ads') return html(`<div class=ad id=ad>ad</div><div id=keep>keep</div>`);
				if (pathname === '/scripts') return html(`<script>window.__atParse = window.__start ?? 'nothing yet'</script><div id=d>here</div><iframe id=f src="/framed"></iframe>`);
				if (pathname === '/many') {
					const n = Number(url.searchParams.get('n')), tag = url.searchParams.get('tag');
					let images = '';
					for (let i = 0; i < n; i++) images += `<img src="/many-${tag}/${i}.png" width=1 height=1>`;
					return html(images);
				}
				return html(`<p id=p>${pathname}</p>`);
			},
			websocket: { message() {} },
		});
		site = `http://127.0.0.2:${server.port}`;
		other = `http://127.0.0.3:${server.port}`;
		own = `http://localhost:${server.port}`;
		control = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			idleTimeout: 0,
			fetch(req) {
				const { pathname } = new URL(req.url);
				if (pathname.startsWith('/aborted/')) {
					aborted.push(pathname.slice('/aborted'.length));
					return new Response('ok');
				}
				return new Promise((done) => released.set(pathname.slice('/wait/'.length), () => done(new Response('go'))));
			},
		});
		app = await launch({ app: APP, timeout: 90_000, env: { NOTES_PROTOCOL_CONTROL: `http://127.0.0.1:${control.port}` } });
		await app.waitFor('#counter', { timeout: 30_000 });
		await op('window', 'setTitle', { windowId: 0, title: 'E2E sessions window' });
		await op('window', 'setBounds', { windowId: 0, x: 300, y: 60, width: 900, height: 650 });
	}, 150_000);
	afterAll(async () => {
		await app?.close().catch(() => {});
		server?.stop(true);
		control?.stop(true);
	}, 30_000);

	check('report: every operation of this batch is registered', async () => {
		const report = await op<{ services: Record<string, Record<string, string>> }>('capabilities', 'describe');
		for (const [service, name] of [['sessions', 'create'], ['sessions', 'remove'], ['sessions', 'setProxy'], ['sessions', 'getProxy'], ['sessions', 'list'], ['sessions', 'capabilities'], ['sessions', 'cookiesGet'], ['sessions', 'cookiesSet'], ['sessions', 'cookiesRemove'], ['sessions', 'watchCookies'], ['protocol', 'response'], ['protocol', 'data'], ['protocol', 'finish'], ['protocol', 'fail'], ['webview', 'setContentRules'], ['webview', 'removeContentRules'], ['webview', 'listContentRules'], ['webview', 'registerScript'], ['webview', 'unregisterScript'], ['webview', 'listScripts'], ['webview', 'setInputPolicy'], ['webview', 'getInputPolicy']] as const)
			expect({ service, name, status: report.services[service]?.[name] }).toEqual({ service, name, status: 'implemented' });
		expect(await s('capabilities')).toEqual({ private: true, persistentNamed: true, proxy: true, proxyAuthentication: true, pac: false, customBypass: false });
	});

	// ── sessions ───────────────────────────────────────────────────────────

	check('sessions.create: what it refuses, what it takes, what list says', async () => {
		for (const args of [{ id: '', persistent: false }, { id: 'default', persistent: false }, { id: 'x'.repeat(201), persistent: false }, { id: 'x' }, { id: 'x', persistent: 'yes' }])
			expect(await code('sessions', 'create', args)).toBe('invalid_args');
		expect(await s('create', { id: 'one', persistent: false })).toEqual({ id: 'one', persistent: false });
		expect(await code('sessions', 'create', { id: 'one', persistent: false })).toBe('invalid_args');
		expect(await s('create', { id: 'disk', persistent: true })).toEqual({ id: 'disk', persistent: true });
		await s('create', { id: 'two', persistent: false });
		expect((await s<{ id: string }[]>('list')).map((x) => x.id)).toEqual(['default', 'disk', 'one', 'two']);
		expect(await s('getProxy', { session: 'one' })).toBeNull();
	});

	check('sessions: an unknown session is refused wherever one is named', async () => {
		const bounds = { x: 0, y: 0, width: 10, height: 10 };
		expect(await code('view', 'create', { id: 'bad', url: `${site}/`, session: 'nope', bounds })).toBe('invalid_args');
		expect(await code('popover', 'create', { id: 'bad', route: '/', session: 'nope' })).toBe('invalid_args');
		expect(await code('window', 'create', { path: '/', session: 'nope' })).toBe('invalid_args');
		for (const name of ['cookiesGet', 'getProxy', 'remove']) expect(await code('sessions', name, { session: 'nope' })).toBe('invalid_args');
		expect(await code('sessions', 'remove', { session: 'default' })).toBe('denied');
	});

	check('isolation: a real cookie one session sends and the others don\'t, read by a real server', async () => {
		await openView('in-one', `${site}/one`, { session: 'one' });
		await openView('in-two', `${site}/two`, { session: 'two' });
		await openView('in-default', `${site}/default`);
		await inView('in-one', `fetch('/set?who=one').then(() => 1)`);
		await inView('in-two', `fetch('/set?who=two').then(() => 1)`);
		expect(await cookieAt('in-one')).toContain('who=one');
		expect(await cookieAt('in-two')).toContain('who=two');
		expect(await cookieAt('in-default')).not.toContain('who=');
		expect((await s('cookiesGet', { session: 'one', url: `${site}/`, name: 'who' }))[0]?.value).toBe('one');
		expect((await s('cookiesGet', { session: 'two', url: `${site}/`, name: 'who' }))[0]?.value).toBe('two');
		expect(await s('cookiesGet', { url: `${site}/`, name: 'who' })).toEqual([]);
		await inView('in-one', `localStorage.setItem('kept', 'one'); 1`);
		expect(await inView('in-two', `localStorage.getItem('kept')`)).toBeNull();
		expect(await inView('in-default', `localStorage.getItem('kept')`)).toBeNull();
	});

	check('cookies per session: set and removed there only, with an event that says which', async () => {
		await s('watchCookies', { enabled: true });
		try {
			const changed = app.nextEvent('sessionCookieChanged', (e: { session: string; cookie: { name: string } }) => e.session === 'two' && e.cookie.name === 'api', 10_000);
			await Bun.sleep(1200); // the comparison's first look
			await s('cookiesSet', { session: 'two', url: `${site}/`, name: 'api', value: 'for-two' });
			expect(await changed).toMatchObject({ removed: false, cookie: { value: 'for-two' } });
			expect(await cookieAt('in-two')).toContain('api=for-two');
			expect(await cookieAt('in-one')).not.toContain('api=');
			expect(await cookieAt('in-default')).not.toContain('api=');
			// A page's own write is only seen by the comparison, within a second or so: WebView2 has no event.
			const fromPage = app.nextEvent('sessionCookieChanged', (e: { session: string; cookie: { name: string } }) => e.session === 'one' && e.cookie.name === 'mine', 10_000);
			await inView('in-one', `document.cookie = 'mine=page; path=/'; 1`);
			await fromPage;
			const gone = app.nextEvent('sessionCookieChanged', (e: { session: string; cookie: { name: string }; removed: boolean }) => e.session === 'two' && e.cookie.name === 'api' && e.removed, 10_000);
			expect(await s('cookiesRemove', { session: 'two', url: `${site}/`, name: 'api' })).toEqual({ removed: 1 });
			await gone;
			expect(await cookieAt('in-two')).not.toContain('api=');
		} finally {
			await s('watchCookies', { enabled: false });
		}
	});

	check('the shell\'s cookie: copied so a session gets past the gate, and never shown', async () => {
		await s('cookiesSet', { url: `${app.origin}/`, name: 'main-only', value: '1' });
		await openView('app-in-one', `${app.origin}/`, { session: 'one' });
		await until('the app\'s page behind the gate', async () => (await inView('app-in-one', `!!document.querySelector('#counter')`)) === true, 20_000);
		expect(await inView('app-in-one', `document.body.innerText`)).not.toContain('Forbidden');
		expect(await inView('app-in-one', `document.cookie`)).not.toContain('__kitop');
		expect(await inView('app-in-one', `document.cookie`)).not.toContain('main-only');
		expect((await s<{ name: string }[]>('cookiesGet', { session: 'one', url: `${app.origin}/` })).map((c) => c.name)).not.toContain('__kitop');
		expect(await code('sessions', 'cookiesGet', { session: 'one', name: '__kitop' })).toBe('denied');
		expect(await code('sessions', 'cookiesSet', { session: 'one', url: `${app.origin}/`, name: '__kitop', value: 'x' })).toBe('denied');
		await closeView('app-in-one');
		await s('cookiesRemove', { url: `${app.origin}/`, name: 'main-only' });
	});

	check('windows, popovers and tabs in a session: its cookies, and list says which', async () => {
		await s('cookiesSet', { session: 'one', url: `${app.origin}/`, name: 'in-session', value: 'yes' });
		const { windowId } = await op<{ windowId: number }>('window', 'create', { path: '/', session: 'one', visible: false, label: 'in-one' });
		try {
			await until('the window\'s page', async () => (await wv<string>('executeJavaScript', { windowId, code: `location.origin + document.readyState` })) === `${app.origin}complete`, 20_000);
			expect(await wv('executeJavaScript', { windowId, code: 'document.cookie' })).toContain('in-session=yes');
			expect(await wv('executeJavaScript', { windowId: 0, code: 'document.cookie' })).not.toContain('in-session');
			const rows = await op<{ windowId: number; session: string | null }[]>('window', 'list');
			expect(rows.find((r) => r.windowId === windowId)?.session).toBe('one');
			expect(rows.find((r) => r.windowId === 0)?.session).toBeNull();
			expect(await code('sessions', 'remove', { session: 'one' })).toBe('unavailable');
			await op('view', 'create', { id: 'tab', url: `${site}/in-tab`, tab: true, windowId, bounds: { x: 0, y: 0, width: 100, height: 100 } });
			await until('the tab asked', async () => hits.has('/in-tab'), 20_000);
			expect(seen.get('/in-tab')).toContain('who=one');
			await closeView('tab');
		} finally {
			await op('window', 'close', { windowId });
		}
		await op('popover', 'create', { id: 'in-two', route: '/', session: 'two' });
		try {
			await s('cookiesSet', { session: 'two', url: `${app.origin}/`, name: 'pop', value: 'two' });
			await until('the popover\'s page', async () => String(await wv('executeJavaScript', { popoverId: 'in-two', code: 'document.cookie' })).includes('pop=two'), 20_000);
			expect(await wv('executeJavaScript', { windowId: 0, code: 'document.cookie' })).not.toContain('pop=two');
		} finally {
			await op('popover', 'destroy', { id: 'in-two' });
		}
		await s('cookiesRemove', { session: 'one', url: `${app.origin}/`, name: 'in-session' });
	});

	check('sessions.remove: not while in use; then gone; the same id again starts empty', async () => {
		expect(await code('sessions', 'remove', { session: 'one' })).toBe('unavailable');
		await closeView('in-one');
		await s('remove', { session: 'one' });
		expect((await s<{ id: string }[]>('list')).map((x) => x.id)).not.toContain('one');
		expect(await code('sessions', 'cookiesGet', { session: 'one' })).toBe('invalid_args');
		expect(await code('view', 'create', { id: 'late', url: `${site}/`, session: 'one', bounds: { x: 0, y: 0, width: 10, height: 10 } })).toBe('invalid_args');
		await s('create', { id: 'one', persistent: false });
		expect(await s('cookiesGet', { session: 'one', url: `${site}/` })).toEqual([]);
		await s('remove', { session: 'one' });
		// A session with no web view of the app's reaches its cookies all the same.
		await s('cookiesSet', { session: 'disk', url: `${site}/`, name: 'on-disk', value: 'kept', expires: Math.floor(Date.now() / 1000) + 3600 });
		expect((await s('cookiesGet', { session: 'disk', url: `${site}/`, name: 'on-disk' }))[0]?.value).toBe('kept');
		await s('remove', { session: 'disk' });
		await s('create', { id: 'disk', persistent: true });
		expect(await s('cookiesGet', { session: 'disk', url: `${site}/` })).toEqual([]);
		await s('remove', { session: 'disk' });
		await closeView('in-two');
		await s('remove', { session: 'two' });
		await closeView('in-default');
	});

	// ── proxies ────────────────────────────────────────────────────────────

	type Seen = { line: string; auth: string | null; cookie: string | null };
	const startProxy = (options: { wantAuth?: () => boolean; tls?: boolean } = {}) => {
		const proxied: Seen[] = [];
		const listener = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			...(options.tls ? { tls: { cert: CERT, key: KEY } } : {}),
			socket: {
				data(socket, data) {
					const text = data.toString(), line = text.split('\r\n')[0]!;
					const auth = text.match(/proxy-authorization: *(.*)/i)?.[1]?.trim() ?? null;
					proxied.push({ line, auth, cookie: text.match(/\ncookie: *(.*)/i)?.[1]?.trim() ?? null });
					if (options.wantAuth?.() && !auth) {
						socket.write(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="p"\r\nContent-Length: 0\r\n\r\n`);
						return;
					}
					if (line.startsWith('CONNECT')) {
						socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
						socket.end();
						return;
					}
					const body = line.includes('/ask') ? 'asked' : `<!doctype html><title>via</title><p id=p>via proxy</p>`;
					const status = line.includes('/ask') ? `401 Unauthorized\r\nWWW-Authenticate: Basic realm="a site"` : '200 OK';
					socket.write(`HTTP/1.1 ${status}\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
					socket.end();
				},
			},
		});
		return { proxied, port: listener.port, stop: () => listener.stop(true) };
	};

	check('sessions.setProxy: what it refuses; the default session keeps its own', async () => {
		await s('create', { id: 'p', persistent: false });
		const bad: [Record<string, unknown>, string][] = [
			[{ type: 'ftp', host: 'h', port: 1 }, 'invalid_args'], [{ type: 'http', host: '', port: 1 }, 'invalid_args'], [{ type: 'http', host: 'h', port: 70000 }, 'invalid_args'], [{ type: 'http', host: 'h', port: 1.5 }, 'invalid_args'],
			[{ type: 'socks', host: 'h', port: 1, tls: true }, 'invalid_args'], [{ type: 'http', host: 'h', port: 1, password: 'p' }, 'invalid_args'], [{ type: 'http', host: 'h', port: 1, username: 3 }, 'invalid_args'],
			// It ends up on a command line.
			[{ type: 'http', host: 'h --remote-debugging-port=9222', port: 1 }, 'invalid_args'], [{ type: 'http', host: 'h"', port: 1 }, 'invalid_args'],
			[{ type: 'http', host: 'h', port: 1, pac: 'x' }, 'unsupported'], [{ type: 'socks', host: 'h', port: 1, username: 'u' }, 'unsupported'],
		];
		for (const [proxy, expected] of bad) expect({ proxy, code: await code('sessions', 'setProxy', { session: 'p', proxy }) }).toEqual({ proxy, code: expected });
		expect(await code('sessions', 'setProxy', { session: 'p' })).toBe('invalid_args');
		expect(await code('sessions', 'setProxy', { proxy: { type: 'http', host: '127.0.0.1', port: 8080 } })).toBe('unsupported');
		expect(await s('setProxy', { proxy: null })).toBeNull();
		expect(await s('getProxy')).toBeNull();
	});

	check('a proxy: the real one sees the request, the others go direct, cookies come along', async () => {
		const proxy = startProxy();
		await s('cookiesSet', { session: 'p', url: 'http://no-such-host.invalid/', name: 'before', value: 'proxy' });
		await s('create', { id: 'direct', persistent: false });
		try {
			await s('setProxy', { session: 'p', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port } });
			expect(await s('getProxy', { session: 'p' })).toEqual({ type: 'http', host: '127.0.0.1', port: proxy.port, tls: false, authenticated: false });
			await openView('via', 'http://no-such-host.invalid/through', { session: 'p' });
			await untilText('via', 'via proxy');
			const asked = proxy.proxied.find((x) => x.line.startsWith('GET http://no-such-host.invalid/through'));
			expect(asked).toBeTruthy();
			expect(asked!.cookie).toContain('before=proxy');
			// The other sessions don't go through it, and loopback hosts never do.
			const count = proxy.proxied.length;
			await openView('not-via', `${site}/not-proxied`, { session: 'direct' });
			await openView('main-view', `${site}/not-proxied-main`);
			await go('via', `${site}/loopback`);
			const through = proxy.proxied.slice(count).map((x) => x.line);
			log('through the proxy since', JSON.stringify(through));
			expect(through.filter((line) => /not-proxied|loopback|127\.0\.0/.test(line))).toEqual([]);
			expect(hits.has('/not-proxied') && hits.has('/not-proxied-main') && hits.has('/loopback')).toBe(true);
			await closeView('not-via');
			await closeView('main-view');
			await s('remove', { session: 'direct' });

			// With a view open: refused, the view stays as it was.
			await go('via', 'http://no-such-host.invalid/still');
			expect(await code('sessions', 'setProxy', { session: 'p', proxy: null })).toBe('unavailable');
			await untilText('via', 'via proxy');
			expect(proxy.proxied.some((x) => x.line.includes('/still'))).toBe(true);
			expect(await s('getProxy', { session: 'p' })).toMatchObject({ port: proxy.port });
			await closeView('via');

			// A new proxy, for what opens next, on the same data.
			const second = startProxy();
			try {
				await s('setProxy', { session: 'p', proxy: { type: 'http', host: '127.0.0.1', port: second.port } });
				expect((await s('cookiesGet', { session: 'p', url: 'http://no-such-host.invalid/', name: 'before' }))[0]?.value).toBe('proxy');
				const before = proxy.proxied.length;
				await openView('via', 'http://no-such-host.invalid/second', { session: 'p' });
				await untilText('via', 'via proxy');
				expect(second.proxied.some((x) => x.line.includes('/second'))).toBe(true);
				expect(proxy.proxied.length).toBe(before);
				await closeView('via');
				// null: back to the system's.
				await s('setProxy', { session: 'p', proxy: null });
				expect(await s('getProxy', { session: 'p' })).toBeNull();
				const again = second.proxied.length;
				await openView('via', `${site}/after-proxy`, { session: 'p' });
				await untilText('via', '/after-proxy');
				expect(second.proxied.length).toBe(again);
				await closeView('via');
			} finally {
				second.stop();
			}
		} finally {
			proxy.stop();
			await closeView('via');
			await closeView('not-via');
			await closeView('main-view');
		}
	}, 120_000);

	check('proxy credentials: they reach the proxy, getProxy doesn\'t return them, a site doesn\'t get them', async () => {
		const proxy = startProxy({ wantAuth: () => true });
		const expected = `Basic ${btoa('me:s3:cret')}`;
		await s('setProxy', { session: 'p', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port, username: 'me', password: 's3:cret' } });
		try {
			const shown = await s('getProxy', { session: 'p' });
			expect(shown).toEqual({ type: 'http', host: '127.0.0.1', port: proxy.port, tls: false, authenticated: true });
			await openView('via', 'http://no-such-host.invalid/auth', { session: 'p' });
			await untilText('via', 'via proxy');
			expect(proxy.proxied.some((x) => x.auth === expected)).toBe(true);
			// A site asking for a password through that proxy isn't the proxy.
			const before = proxy.proxied.length;
			const challenge = app.nextEvent('webAuthChallenge', undefined, 15_000).catch(() => null);
			await wv('configurePolicy', { kind: 'auth', enabled: true, timeoutMs: 2000 });
			await op('view', 'navigate', { id: 'via', url: 'http://no-such-host.invalid/ask' });
			const asked = await challenge;
			expect(asked).toMatchObject({ host: 'no-such-host.invalid', proxy: false });
			await wv('configurePolicy', { kind: 'auth', enabled: false });
			await until('the 401 came', async () => proxy.proxied.length > before, 10_000);
		} finally {
			await wv('configurePolicy', { kind: 'auth', enabled: false }).catch(() => {});
			await closeView('via');
			proxy.stop();
		}
		// No credentials: the proxy's challenge goes to the handler, marked as one.
		const asking = startProxy({ wantAuth: () => true });
		await s('setProxy', { session: 'p', proxy: { type: 'http', host: '127.0.0.1', port: asking.port } });
		await wv('configurePolicy', { kind: 'auth', enabled: true, timeoutMs: 10_000 });
		try {
			const challenged = app.nextEvent<{ requestId: string; proxy: boolean; port: number }>('webAuthChallenge', undefined, 15_000);
			await op('view', 'create', { id: 'via', windowId: 0, url: 'http://no-such-host.invalid/handler', session: 'p', bounds: { x: 0, y: 0, width: 100, height: 100 } });
			const challenge = await challenged;
			expect(challenge).toMatchObject({ proxy: true, port: asking.port });
			await wv('respondPolicy', { requestId: challenge.requestId, answer: { username: 'by', password: 'handler' } });
			await untilText('via', 'via proxy');
			expect(asking.proxied.some((x) => x.auth === `Basic ${btoa('by:handler')}`)).toBe(true);
		} finally {
			await wv('configurePolicy', { kind: 'auth', enabled: false }).catch(() => {});
			await closeView('via');
			asking.stop();
		}
		// Wrong ones aren't tried for ever: the page gets the proxy's answer.
		let refusals = 0;
		const reject = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				data(socket, data) {
					if (data.toString().includes('/refused')) refusals++;
					socket.write(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="p"\r\nContent-Length: 0\r\n\r\n`);
				},
			},
		});
		await s('setProxy', { session: 'p', proxy: { type: 'http', host: '127.0.0.1', port: reject.port, username: 'me', password: 'wrong' } });
		try {
			await op('view', 'create', { id: 'refused', windowId: 0, url: 'http://no-such-host.invalid/refused', session: 'p', bounds: { x: 0, y: 0, width: 100, height: 100 } });
			await until('it was refused', async () => refusals >= 4, 15_000);
			await Bun.sleep(2500);
			log('refused by the proxy', refusals, 'times');
			expect(refusals).toBeLessThanOrEqual(8);
		} finally {
			await closeView('refused');
			reject.stop(true);
		}
	}, 120_000);

	check('SOCKS5: a real handshake, and the proxy sees the host', async () => {
		const socks: string[] = [];
		const listener = Bun.listen<{ step: number }>({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				open(socket) {
					socket.data = { step: 0 };
				},
				data(socket, data) {
					const bytes = new Uint8Array(data);
					if (socket.data.step === 0) {
						socket.data.step = 1;
						socket.write(new Uint8Array([5, 0]));
						return;
					}
					if (socket.data.step === 1) {
						socket.data.step = 2;
						socks.push(new TextDecoder().decode(bytes.subarray(5, 5 + bytes[4]!)));
						socket.write(new Uint8Array([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
						return;
					}
					const body = `<!doctype html><p id=p>via socks</p>`;
					socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
					socket.end();
				},
			},
		});
		await s('setProxy', { session: 'p', proxy: { type: 'socks', host: '127.0.0.1', port: listener.port } });
		try {
			await openView('via', 'http://through-socks.invalid/', { session: 'p' });
			await untilText('via', 'via socks');
			expect(socks).toContain('through-socks.invalid');
		} finally {
			await closeView('via');
			listener.stop(true);
		}
	}, 60_000);

	check('tls: true: the proxy is spoken to over TLS, the URL isn\'t in the clear', async () => {
		const raw: Buffer[] = [];
		const plain = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				data(socket, data) {
					raw.push(Buffer.from(data));
					socket.end();
				},
			},
		});
		await s('setProxy', { session: 'p', proxy: { type: 'http', host: '127.0.0.1', port: plain.port, tls: true } });
		try {
			expect(await s('getProxy', { session: 'p' })).toMatchObject({ tls: true });
			await op('view', 'create', { id: 'via', windowId: 0, url: 'http://secret-path.invalid/secret', session: 'p', bounds: { x: 0, y: 0, width: 100, height: 100 } });
			await until('a connection', async () => raw.length > 0, 15_000);
			expect(raw[0]![0]).toBe(0x16);
			expect(Buffer.concat(raw).includes('secret-path')).toBe(false);
		} finally {
			await closeView('via');
			plain.stop(true);
		}
		// A real TLS proxy, trusted the way a machine would trust one.
		const pem = join(tmp, 'proxy.pem');
		writeFileSync(pem, CERT);
		const imported = await ps(`certutil -addstore -f Root '${pem}'`);
		log('certificate', imported.out, imported.err);
		const secure = startProxy({ tls: true });
		await s('setProxy', { session: 'p', proxy: { type: 'http', host: '127.0.0.1', port: secure.port, tls: true } });
		try {
			await openView('via', 'http://through-tls.invalid/', { session: 'p' });
			await untilText('via', 'via proxy');
			expect(secure.proxied.some((x) => x.line.startsWith('GET http://through-tls.invalid/'))).toBe(true);
		} finally {
			await closeView('via');
			secure.stop();
			await ps(`certutil -delstore Root 'kitop test'`);
		}
	}, 90_000);

	check('a session with its own environment: its folder, deleted with it', async () => {
		const before = existsSync(profileFolder()) ? readdirSync(profileFolder()) : [];
		await s('create', { id: 'q', persistent: false });
		await s('setProxy', { session: 'q', proxy: { type: 'http', host: '127.0.0.1', port: 9 } });
		const during = readdirSync(profileFolder()).filter((x) => !before.includes(x));
		expect(during.length).toBe(1);
		await s('remove', { session: 'q' });
		expect(readdirSync(profileFolder())).not.toContain(during[0]);
		await s('setProxy', { session: 'p', proxy: null });
		await s('remove', { session: 'p' });
		expect(existsSync(profileFolder()) ? readdirSync(profileFolder()) : []).toEqual([]);
		log('a browser process that had to be ended', (app.stdout.match(/browser process didn't stop/g) ?? []).length, 'times');
	}, 60_000);

	// ── custom schemes ─────────────────────────────────────────────────────

	const image = (id: string, url: string) => inView(id, `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve({ loaded: true, width: i.naturalWidth }); i.onerror = () => resolve({ loaded: false }); i.src = ${JSON.stringify(url)}; })`);
	const lastRequest = (url: string, ms = 10_000) => app.nextEvent<{ requestId: string; url: string; method: string; headers: Record<string, string> }>('protocolRequest', (e) => e.url === url, ms);
	const asset = 'notes-asset://archive';

	check('protocols: real content in a page: an image, a script, a frame, a page of its own', async () => {
		await openView('site', `${site}/`);
		const asked = lastRequest(`${asset}/pixel.png?1`);
		expect(await image('site', `${asset}/pixel.png?1`)).toEqual({ loaded: true, width: 1 });
		expect(await asked).toMatchObject({ method: 'GET', url: `${asset}/pixel.png?1` });
		expect(await inView('site', `new Promise((resolve) => { const s = document.createElement('script'); s.onload = () => resolve(window.fromScheme); s.onerror = () => resolve('error'); s.src = '${asset}/script.js'; document.head.append(s); })`)).toBe('ran');
		await openView('page', `${asset}/page.html`);
		expect(await inView('page', `document.getElementById('p').textContent + '|' + document.title`)).toBe('from the scheme|scheme page');
		const { windowId } = await op<{ windowId: number }>('window', 'create', { url: `${asset}/page.html`, visible: false });
		try {
			await until('a window stays on the scheme', async () => (await wv('executeJavaScript', { windowId, code: `document.getElementById('p')?.textContent` })) === 'from the scheme', 15_000);
		} finally {
			await op('window', 'close', { windowId });
		}
	});

	check('protocols: a frame, and fetch() from an ordinary page', async () => {
		expect(await inView('site', `new Promise((resolve) => { addEventListener('message', (e) => resolve(e.data), { once: true }); const f = document.createElement('iframe'); f.src = '${asset}/frame.html'; document.body.append(f); setTimeout(() => resolve('timeout'), 5000); })`)).toBe('frame says hi');
		// Cross-origin, not CORS-enabled, as on Linux.
		expect(await inView('site', `fetch('${asset}/echo', { method: 'POST', body: 'x' }).then((r) => r.status + ' ' + r.type, () => 'refused')`)).toBe('refused');
	});

	check('protocols: fetch on its own origin: 8 MB byte for byte, statuses, headers, a POST body, a failure', async () => {
		const bytes = await inView('page', `fetch('/big.bin').then(async (r) => { const b = new Uint8Array(await r.arrayBuffer()); let ok = b.length === ${BIG}; for (let i = 0; ok && i < b.length; i++) ok = b[i] === ((i * 31) & 255); return { ok, length: b.length, type: r.headers.get('content-type') }; })`, 60_000);
		expect(bytes).toEqual({ ok: true, length: BIG, type: 'application/octet-stream' });
		expect(await inView('page', `fetch('/missing').then(async (r) => ({ status: r.status, custom: r.headers.get('x-custom'), text: await r.text() }))`)).toEqual({ status: 404, custom: 'yes', text: 'not here' });
		expect(await inView('page', `fetch('/echo', { method: 'POST', headers: { 'content-type': 'text/x-test' }, body: 'the body' }).then(async (r) => [await r.text(), r.headers.get('x-got')])`)).toEqual(['POST:the body', 'text/x-test']);
		const cancel = app.nextEvent('protocolCancel', undefined, 10_000);
		expect(await inView('page', `fetch('/throws').then(() => 'answered', () => 'failed')`)).toBe('failed');
		await cancel;
		expect(await inView('page', `fetch('/empty').then(async (r) => r.status + ':' + (await r.text()).length)`)).toBe('204:0');
		expect(await inView('page', `fetch('/unknown').then((r) => r.status)`)).toBe(404);
	}, 120_000);

	check('protocols: WebView2 takes a response whole: the page sees nothing until it ends, then all of it', async () => {
		const asked = lastRequest(`${asset}/stream.html`);
		let shown = false;
		const whole = app.nextEvent('viewLoaded', (e: { id: string; url: string }) => e.id === 'page' && e.url.endsWith('stream.html'), 30_000).then(() => (shown = true));
		await op('view', 'navigate', { id: 'page', url: `${asset}/stream.html` });
		await asked;
		await until('the handler is on its second chunk', async () => released.has('stream'), 10_000);
		await Bun.sleep(1500);
		expect(shown).toBe(false);
		expect(await inView('site', `1 + 1`)).toBe(2); // the other views go on
		release('stream');
		await whole;
		expect(await inView('page', `window.firstChunk === true && document.getElementById('second')?.textContent + document.readyState`)).toBe('twocomplete');
	}, 60_000);

	check('protocols: a request going away: leaving the document or the view, flowing or waiting; a fetch aborted before that isn\'t noticed', async () => {
		aborted.length = 0;
		await go('page', `${asset}/page.html`);
		// A flowing stream, and an aborted fetch of a waiting one: WebView2 says nothing of either.
		const flowing = lastRequest(`${asset}/endless`);
		await inView('page', `(fetch('/endless').catch(() => {}), 1)`);
		const flow = await flowing;
		const idle = lastRequest(`${asset}/idle`);
		await inView('page', `(window.__c = new AbortController(), fetch('/idle', { signal: window.__c.signal }).catch(() => {}), 1)`);
		const { requestId } = await idle;
		await inView('page', `window.__c.abort(); 1`);
		await Bun.sleep(1200);
		expect(aborted).toEqual([]);
		expect(await inView('page', `window.__first ?? 'nothing'`)).toBe('nothing');
		// Leaving: both end, and the handler hears it.
		const ended = Promise.all([flow.requestId, requestId].map((id) => app.nextEvent('protocolCancel', (e: { requestId: string }) => e.requestId === id, 15_000)));
		await go('page', `${asset}/page.html?again`);
		await ended;
		await until('the handler heard it', async () => aborted.includes('/idle') && aborted.includes('/endless'), 10_000);
		expect(await code('protocol', 'data', { requestId, data: Buffer.from('late').toString('base64') })).toBe('unavailable');
		// A page's own document request carries on past its own commit, and an older one doesn't.
		const gone = lastRequest(`${asset}/hold?gone`);
		await inView('page', `(() => { const i = new Image(); i.src = '${asset}/hold?gone'; window.__i = i; return 1 })()`);
		const held = await gone;
		const left = app.nextEvent('protocolCancel', (e: { requestId: string }) => e.requestId === held.requestId, 15_000);
		await closeView('page');
		await left;
	}, 90_000);

	check('protocol.*: the native ops: order, bad values, a page refused, the 30 second deadline', async () => {
		for (const name of ['response', 'data', 'finish', 'fail']) {
			expect(await code('protocol', name, { requestId: 'nope', status: 200, headers: {} })).toBe('unavailable');
			expect(await wv('executeJavaScript', { windowId: 0, code: `window.__shell ? 'ok' : 'none'` })).toBe('ok');
		}
		// From a page, a throwaway one: taking the bridge's events from it takes them from its host.
		await openView('app-page', `${app.origin}/`);
		await until('its page', async () => (await inView('app-page', `document.readyState`)) === 'complete', 15_000);
		expect(await inView('app-page', `new Promise((resolve) => { window.__shell.setSink((n, d) => { if (n === 'platformResult' && d.id === 'probe') resolve(d.error?.code ?? 'ok'); }); window.__shell.post({ id: 'probe', service: 'protocol', op: 'finish', args: { requestId: 'nope' } }); setTimeout(() => resolve('nothing'), 5000); })`)).toBe('denied');
		await closeView('app-page');
		const load = (query: string) => inView('site', `(window.__load = new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('loaded ' + i.naturalWidth); i.onerror = () => resolve('error'); i.src = '${asset}/hold?${query}'; }), 1)`);
		const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
		let asked = lastRequest(`${asset}/hold?1`);
		await load('1');
		const { requestId } = await asked;
		const p = (name: string, args: Record<string, unknown> = {}) => code('protocol', name, { requestId, ...args });
		expect(await p('data', { data: PIXEL })).toBe('invalid_args');
		expect(await p('finish')).toBe('invalid_args');
		expect(await p('response', { status: 99, headers: {} })).toBe('invalid_args');
		expect(await p('response', { status: 200 })).toBe('invalid_args');
		expect(await p('response', { status: 200, headers: { a: 1 } })).toBe('invalid_args');
		expect(await p('response', { status: 200, headers: { a: 'x\r\ny: z' } })).toBe('invalid_args');
		expect(await p('response', { status: 200, headers: { 'content-type': 'image/png' } })).toBe('ok');
		expect(await p('response', { status: 200, headers: {} })).toBe('invalid_args');
		expect(await p('data', { data: Buffer.alloc(70000).toString('base64') })).toBe('invalid_args');
		expect(await p('data', { data: '@@@' })).toBe('invalid_args');
		expect(await p('data', { data: PIXEL })).toBe('ok');
		expect(await p('finish')).toBe('ok');
		expect(await inView('site', `window.__load`)).toBe('loaded 1');
		expect(await p('finish')).toBe('unavailable');
		// Failing before the response, and after it.
		asked = lastRequest(`${asset}/hold?2`);
		await load('2');
		const failed = await asked;
		await op('protocol', 'fail', { requestId: failed.requestId, message: 'no' });
		expect(await inView('site', `window.__load`)).toBe('error');
		asked = lastRequest(`${asset}/hold?3`);
		await load('3');
		const late = await asked;
		await op('protocol', 'response', { requestId: late.requestId, status: 200, headers: { 'content-type': 'image/png' } });
		await op('protocol', 'fail', { requestId: late.requestId, message: 'no' });
		expect(await inView('site', `window.__load`)).toBe('error');
		// Not answered in 30 seconds: it fails, and says so.
		asked = lastRequest(`${asset}/hold?4`);
		await load('4');
		const waiting = await asked;
		const cancelled = app.nextEvent('protocolCancel', (e: { requestId: string }) => e.requestId === waiting.requestId, 40_000);
		await Bun.sleep(5000);
		await cancelled;
		expect(await inView('site', `window.__load`)).toBe('error');
	}, 120_000);

	check('protocols hold in a named session and in a session\'s own environment', async () => {
		await s('create', { id: 'schemes', persistent: false });
		await openView('other-site', `${site}/`, { session: 'schemes' });
		expect(await image('other-site', `${asset}/pixel.png?named`)).toEqual({ loaded: true, width: 1 });
		await openView('other-page', `${asset}/page.html`, { session: 'schemes' });
		expect(await inView('other-page', `document.title`)).toBe('scheme page');
		await closeView('other-site');
		await closeView('other-page');
		await s('setProxy', { session: 'schemes', proxy: { type: 'http', host: '127.0.0.1', port: 9 } });
		await openView('other-page', `${asset}/page.html`, { session: 'schemes' });
		expect(await inView('other-page', `document.title`)).toBe('scheme page');
		expect(await inView('other-page', `fetch('/pixel.png').then((r) => r.status)`)).toBe(200);
		await closeView('other-page');
		await s('remove', { session: 'schemes' });
	}, 60_000);

	// ── content rules ──────────────────────────────────────────────────────

	const block = (filter: string, trigger: Record<string, unknown> = {}) => ({ trigger: { 'url-filter': filter, ...trigger }, action: { type: 'block' } });
	const rules = (id: string, list: unknown[]) => wv('setContentRules', { id, rules: list });
	const tryFetch = (id: string, url: string) => inView(id, `fetch(${JSON.stringify(url)}).then((r) => r.status, () => 'failed')`);
	const tryImage = (id: string, url: string) => inView(id, `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('loaded'); i.onerror = () => resolve('error'); i.src = ${JSON.stringify(url)}; })`);

	check('setContentRules: what it refuses, and says it can\'t do, rather than ignoring it', async () => {
		const trigger = { 'url-filter': 'x' };
		const invalid: [string, Record<string, unknown>][] = [
			['no id', { rules: [block('x')] }], ['a long id', { id: 'x'.repeat(257), rules: [block('x')] }], ['no rules', { id: 'a' }], ['empty rules', { id: 'a', rules: [] }], ['a rule that isn\'t one', { id: 'a', rules: [3] }],
			['no action type', { id: 'a', rules: [{ trigger, action: {} }] }], ['an unknown action', { id: 'a', rules: [{ trigger, action: { type: 'redirect' } }] }], ['no filter', { id: 'a', rules: [{ trigger: {}, action: { type: 'block' } }] }],
			['alternation', { id: 'a', rules: [block('(a|b)')] }], ['counted repetition', { id: 'a', rules: [block('a{2}')] }], ['a class escape', { id: 'a', rules: [block('\\d')] }], ['an interior anchor', { id: 'a', rules: [block('a^b')] }], ['an unbalanced group', { id: 'a', rules: [block('(a')] }], ['not ASCII', { id: 'a', rules: [block('é')] }], ['a lazy quantifier', { id: 'a', rules: [block('a*?')] }],
			['popup', { id: 'a', rules: [block('x', { 'resource-type': ['popup'] })] }], ['svg-document', { id: 'a', rules: [block('x', { 'resource-type': ['svg-document'] })] }], ['websocket', { id: 'a', rules: [block('x', { 'resource-type': ['websocket'] })] }], ['block-cookies', { id: 'a', rules: [{ trigger, action: { type: 'block-cookies' } }] }], ['an unknown type', { id: 'a', rules: [block('x', { 'resource-type': ['nope'] })] }], ['a load type', { id: 'a', rules: [block('x', { 'load-type': ['nope'] })] }],
			['a frame condition', { id: 'a', rules: [block('x', { 'if-frame-url': ['x'] })] }], ['an unknown trigger', { id: 'a', rules: [block('x', { 'load-context': ['top-frame'] })] }], ['two conditions', { id: 'a', rules: [block('x', { 'if-domain': ['a.example'], 'unless-domain': ['b.example'] })] }], ['an uppercase domain', { id: 'a', rules: [block('x', { 'if-domain': ['A.example'] })] }], ['no domains', { id: 'a', rules: [block('x', { 'if-domain': [] })] }],
			['css with if-domain', { id: 'a', rules: [{ trigger: { 'url-filter': '.*', 'if-domain': ['a.example'] }, action: { type: 'css-display-none', selector: 'p' } }] }], ['css with a resource type', { id: 'a', rules: [{ trigger: { 'url-filter': '.*', 'resource-type': ['image'] }, action: { type: 'css-display-none', selector: 'p' } }] }], ['css with no selector', { id: 'a', rules: [{ trigger: { 'url-filter': '.*' }, action: { type: 'css-display-none' } }] }],
		];
		for (const [name, args] of invalid) expect({ name, code: await code('webview', 'setContentRules', args) }).toEqual({ name, code: 'invalid_args' });
		expect(await code('webview', 'removeContentRules', {})).toBe('invalid_args');
		expect(await wv('listContentRules')).toEqual([]);
	});

	check('block: the real server doesn\'t get it, in any session; other requests do; rules come off', async () => {
		await s('create', { id: 'ruled', persistent: false });
		await openView('ruled-site', `${site}/`, { session: 'ruled' });
		expect(await tryFetch('site', '/blocked-a')).toBe(200);
		expect(hits.get('/blocked-a')).toBe(1);
		const list = [block('/blocked-'), block('/also-')];
		await rules('first', list);
		expect(await wv('listContentRules')).toEqual([{ id: 'first', rules: list }]);
		for (const view of ['site', 'ruled-site']) {
			// A local 403, where WebKit fails the request.
			expect(await tryFetch(view, '/blocked-a')).toBe(403);
			expect(await tryFetch(view, '/blocked-b')).toBe(403);
			expect(await tryImage(view, '/also-c')).toBe('error');
			expect(await tryFetch(view, '/allowed')).toBe(200);
		}
		expect(hits.get('/blocked-a')).toBe(1);
		expect(hits.has('/blocked-b') || hits.has('/also-c')).toBe(false);
		expect(hits.get('/allowed')).toBe(2);
		// A document too, and a worker's request.
		const failed = app.nextEvent('viewFailed', (e: { id: string }) => e.id === 'ruled-site', 8000).then((e) => JSON.stringify(e), () => 'no viewFailed');
		await op('view', 'navigate', { id: 'ruled-site', url: `${site}/blocked-doc` });
		expect(await failed).toContain('navigation failed');
		expect(hits.has('/blocked-doc')).toBe(false);
		expect(await inView('ruled-site', `location.href`)).toStartWith('chrome-error:');
		await go('ruled-site', `${site}/`);
		await rules('worker', [block('/from-worker')]);
		await inView('site', `new Promise((resolve) => { const w = new Worker('/worker.js'); w.onmessage = (e) => resolve(e.data); w.onerror = () => resolve('error'); })`);
		expect(hits.has('/from-worker')).toBe(false);
		await wv('removeContentRules', { id: 'worker' });
		// WebView2 doesn't raise the event for a WebSocket: it goes past a rule, which the docs say.
		await rules('socket', [block('/socket')]);
		expect(await inView('site', `new Promise((resolve) => { const w = new WebSocket('ws://127.0.0.2:' + location.port + '/socket'); w.onopen = () => { w.close(); resolve('open'); }; w.onerror = () => resolve('error'); setTimeout(() => resolve('timeout'), 5000); })`)).toBe('open');
		expect(hits.get('/socket')).toBe(1);
		await wv('removeContentRules', { id: 'socket' });
		// Replaced, then removed: requests go through again, from the documents already open.
		await rules('first', [block('/other')]);
		expect(await tryFetch('site', '/blocked-b')).toBe(200);
		expect(hits.get('/blocked-b')).toBe(1);
		expect(await tryImage('site', '/other')).toBe('error');
		await wv('removeContentRules', { id: 'first' });
		expect(await wv('removeContentRules', { id: 'first' })).toBeNull();
		expect(await tryFetch('site', '/other')).toBe(200);
		expect(await wv('listContentRules')).toEqual([]);
	}, 90_000);

	check('the filters: url-filter syntax, resource-type, load-type, if-domain, unless-domain, ignore-previous-rules', async () => {
		try {
			// Case, anchors, groups and classes.
			await rules('syntax', [block('^http://127\\.0\\.0\\.2:[0-9]+/ANCHORED$'), block('/opt(ional)?-[a-c]+x'), block('/CaseSens', { 'url-filter-is-case-sensitive': true })]);
			expect(await tryImage('site', '/anchored')).toBe('error');
			expect(await tryFetch('site', '/anchored-not')).toBe(200);
			expect(await tryImage('site', '/opt-abcx')).toBe('error');
			expect(await tryImage('site', '/optional-ax')).toBe('error');
			expect(await tryFetch('site', '/opt-zx')).toBe(200);
			expect(await tryImage('site', '/CaseSens')).toBe('error');
			expect(await tryFetch('site', '/casesens')).toBe(200);
			await wv('removeContentRules', { id: 'syntax' });
			// resource-type: only images.
			await rules('type', [block('/typed', { 'resource-type': ['image'] })]);
			expect(await tryImage('site', '/typed-1')).toBe('error');
			expect(hits.has('/typed-1')).toBe(false);
			expect(await tryFetch('site', '/typed-2')).toBe(200);
			await wv('removeContentRules', { id: 'type' });
			// load-type, from the page at 127.0.0.2.
			await rules('party', [block('/third', { 'load-type': ['third-party'] }), block('/first', { 'load-type': ['first-party'] })]);
			expect(await tryImage('site', `${other}/third-1`)).toBe('error');
			expect(hits.has('/third-1')).toBe(false);
			await tryImage('site', `${site}/third-2`);
			expect(hits.get('/third-2')).toBe(1);
			expect(await tryImage('site', `${site}/first-1`)).toBe('error');
			expect(hits.has('/first-1')).toBe(false);
			await tryImage('site', `${other}/first-2`);
			expect(hits.get('/first-2')).toBe(1);
			await wv('removeContentRules', { id: 'party' });
			// if-domain and unless-domain: the page's host, `*` for its subdomains.
			await openView('sub', `http://a.localhost:${server.port}/`);
			await openView('bare', `${own}/`);
			await rules('where', [block('/if-sub', { 'if-domain': ['*localhost'] }), block('/if-exact', { 'if-domain': ['localhost'] }), block('/unless', { 'unless-domain': ['*localhost'] })]);
			expect(await tryImage('sub', '/if-sub')).toBe('error');
			await tryImage('site', `${site}/if-sub-2`);
			expect(hits.get('/if-sub-2')).toBe(1);
			await tryImage('sub', '/if-exact');
			expect(hits.get('/if-exact')).toBe(1);
			expect(await tryImage('bare', '/if-exact-2')).toBe('error');
			expect(hits.has('/if-exact-2')).toBe(false);
			expect(await tryImage('site', '/unless')).toBe('error');
			await tryImage('sub', `/unless-2`);
			expect(hits.get('/unless-2')).toBe(1);
			await wv('removeContentRules', { id: 'where' });
			await closeView('sub');
			await closeView('bare');
			// In order, within a list; not across lists.
			await rules('order', [block('/ignored'), { trigger: { 'url-filter': '/ignored-ok' }, action: { type: 'ignore-previous-rules' } }]);
			expect(await tryImage('site', '/ignored-no')).toBe('error');
			await tryImage('site', '/ignored-ok');
			expect(hits.get('/ignored-ok')).toBe(1);
			await rules('order-2', [block('/ignored-ok2')]);
			expect(await tryImage('site', '/ignored-ok2')).toBe('error');
			await wv('removeContentRules', { id: 'order' });
			await wv('removeContentRules', { id: 'order-2' });
		} finally {
			for (const id of ['syntax', 'type', 'party', 'where', 'order', 'order-2']) await wv('removeContentRules', { id }).catch(() => {});
		}
	}, 90_000);

	check('the app is exempt: a rule for everything leaves its document, its resources and its bridge alone', async () => {
		await rules('everything', [block('.*')]);
		try {
			expect(await wv('executeJavaScript', { windowId: 0, code: `fetch('/').then((r) => r.status)` })).toBe(200);
			expect(await tryImage('site', `${other}/under-everything`)).toBe('error');
			expect(hits.has('/under-everything')).toBe(false);
			expect((await op<{ name: string }>('app', 'getInfo')).name).toBeTruthy();
		} finally {
			await wv('removeContentRules', { id: 'everything' });
		}
	});

	check('css-display-none: hidden on the pages it names, not on the others, gone with its rule', async () => {
		const hidden = (id: string, element: string) => inView(id, `getComputedStyle(document.getElementById('${element}')).display === 'none'`);
		await rules('css', [{ trigger: { 'url-filter': '/ads' }, action: { type: 'css-display-none', selector: '.ad' } }, { trigger: { 'url-filter': '/ads', 'unless-domain': ['*localhost'] }, action: { type: 'css-display-none', selector: '#keep' } }]);
		await go('site', `${site}/ads`);
		expect(await hidden('site', 'ad')).toBe(true);
		expect(await hidden('site', 'keep')).toBe(true);
		await go('site', `${site}/ads?other`);
		expect(await hidden('site', 'ad')).toBe(true);
		await openView('bare', `${own}/ads`);
		expect(await hidden('bare', 'ad')).toBe(true);
		expect(await hidden('bare', 'keep')).toBe(false);
		await closeView('bare');
		await wv('removeContentRules', { id: 'css' });
		await go('site', `${site}/ads?after`);
		expect(await hidden('site', 'ad')).toBe(false);
		await go('site', `${site}/`);
	});

	check('make-https: the http request doesn\'t go out, the page comes over TLS', async () => {
		// The same port: what would be plain HTTP reaches a server that only speaks TLS.
		let asked = 0;
		const tls = Bun.serve({
			hostname: '0.0.0.0',
			port: 0,
			tls: { cert: CERT, key: KEY },
			fetch() {
				asked++;
				return html('<p id=p>over tls</p>');
			},
		});
		await wv('configurePolicy', { kind: 'auth', enabled: true, timeoutMs: 5000 });
		try {
			await rules('https', [{ trigger: { 'url-filter': '/upgrade' }, action: { type: 'make-https' } }]);
			const challenged = app.nextEvent<{ requestId: string; method: string; origin: string; fingerprint: string }>('webAuthChallenge', (c) => c.method === 'serverTrust', 15_000);
			await op('view', 'navigate', { id: 'site', url: `http://127.0.0.2:${tls.port}/upgrade` });
			const challenge = await challenged;
			expect(challenge.origin).toBe(`https://127.0.0.2:${tls.port}`);
			await wv('allowCertificate', { host: '127.0.0.2', fingerprint: challenge.fingerprint });
			await wv('respondPolicy', { requestId: challenge.requestId, answer: 'default' });
			await untilText('site', 'over tls');
			expect(asked).toBeGreaterThan(0);
			expect(await inView('site', `location.protocol`)).toBe('https:');
			await wv('revokeCertificate', { host: '127.0.0.2', fingerprint: challenge.fingerprint });
		} finally {
			await wv('configurePolicy', { kind: 'auth', enabled: false });
			await wv('removeContentRules', { id: 'https' });
			tls.stop(true);
			await go('site', `${site}/`);
		}
	}, 60_000);

	check('a page with many requests: all arrive under rules, and what the rules cost', async () => {
		const load = async (tag: string) => {
			const started = performance.now();
			await inView('site', `new Promise((resolve) => { location.href = ${JSON.stringify(`${site}/many?n=400&tag=${tag}`)}; resolve(1); })`).catch(() => {});
			await until('every image asked', async () => [...hits.keys()].filter((k) => k.startsWith(`/many-${tag}/`)).length === 400, 40_000);
			return performance.now() - started;
		};
		const none = await load('none');
		const list = [];
		for (let i = 0; i < 200; i++) list.push(block(`^https?://ads${i}\\.example/[a-z]+/(banner|x)?.*`.replace('(banner|x)?', '(banner)?')));
		await rules('many', list);
		const ruled = await load('ruled');
		await wv('removeContentRules', { id: 'many' });
		const after = await load('after');
		log(`400 images: no rules ${none.toFixed(0)} ms, 200 rules ${ruled.toFixed(0)} ms, rules removed ${after.toFixed(0)} ms`);
		await go('site', `${site}/`);
	}, 150_000);

	// ── registered scripts ─────────────────────────────────────────────────

	check('registered scripts: their real effect: timing, frames, worlds, targets, order, removal', async () => {
		for (const args of [{}, { id: 'a' }, { id: 'a', source: 'x', world: 'page' }, { id: 'a', source: 'x', world: 'page', timing: 'later' }, { id: 'a', source: 'x', world: '', timing: 'start' }, { id: 'a', source: 'x', world: 'page', timing: 'start', target: 3 }, { id: 'a', source: 'x', world: 'page', timing: 'start', target: { windowId: 'x' } }])
			expect(await code('webview', 'registerScript', args)).toBe('invalid_args');
		expect(await code('webview', 'unregisterScript', {})).toBe('invalid_args');
		expect(await wv('listScripts')).toEqual([]);
		await wv('registerScript', { id: 'early', source: `window.__start = (window.__order ??= []).push('early') && 'before the page'; var __asVar = 1;`, timing: 'start', world: 'page' });
		await wv('registerScript', { id: 'second', source: `window.__order.push('second')`, timing: 'start', world: 'page' });
		await wv('registerScript', { id: 'at-end', source: `window.__end = !!document.getElementById('d')`, timing: 'end', world: 'page' });
		await wv('registerScript', { id: 'frames', source: `document.documentElement.dataset.framed = 'yes'`, timing: 'end', world: 'page', mainFrameOnly: false });
		await wv('registerScript', { id: 'top', source: `document.documentElement.dataset.top = 'yes'`, timing: 'end', world: 'page' });
		await wv('registerScript', { id: 'isolated', source: `globalThis.__isolated = true; document.documentElement.dataset.isolated = typeof globalThis.__start;`, timing: 'end', world: 'reader' });
		expect((await wv<{ id: string; mainFrameOnly: boolean }[]>('listScripts')).map((x) => [x.id, x.mainFrameOnly])).toEqual([['early', true], ['second', true], ['at-end', true], ['frames', false], ['top', true], ['isolated', true]]);
		// Not run in the document already there.
		expect(await inView('site', `window.__start ?? 'nothing'`)).toBe('nothing');
		await go('site', `${site}/scripts`);
		await until('the frame', async () => (await inView('site', `document.getElementById('f').contentDocument?.readyState`)) === 'complete');
		expect(await inView('site', `window.__atParse`)).toBe('before the page');
		expect(await inView('site', `window.__asVar`)).toBe(1);
		expect(await inView('site', `window.__order`)).toEqual(['early', 'second']);
		expect(await inView('site', `window.__end`)).toBe(true);
		expect(await inView('site', `document.getElementById('f').contentDocument.documentElement.dataset.framed`)).toBe('yes');
		expect(await inView('site', `document.getElementById('f').contentDocument.documentElement.dataset.top ?? 'none'`)).toBe('none');
		// A named world: the DOM shared, its globals its own.
		expect(await inView('site', `document.documentElement.dataset.isolated`)).toBe('undefined');
		expect(await inView('site', `window.__isolated ?? 'not here'`)).toBe('not here');
		// Replaced in place, and only where its target says.
		await wv('registerScript', { id: 'early', source: `window.__start = (window.__order ??= []).push('early2') && 'replaced'`, timing: 'start', world: 'page' });
		await wv('registerScript', { id: 'targeted', source: `window.__only = 'here'`, timing: 'start', world: 'page', target: { viewId: 'site' } });
		expect((await wv<{ id: string }[]>('listScripts')).map((x) => x.id)).toEqual(['early', 'second', 'at-end', 'frames', 'top', 'isolated', 'targeted']);
		await openView('elsewhere', `${site}/`);
		expect(await inView('elsewhere', `window.__start`)).toBe('replaced');
		expect(await inView('elsewhere', `window.__only ?? 'no'`)).toBe('no');
		await closeView('elsewhere');
		await go('site', `${site}/scripts?2`);
		expect(await inView('site', `window.__order`)).toEqual(['early2', 'second']);
		expect(await inView('site', `window.__only`)).toBe('here');
		// A new session's view has them too, and removal ends them at the next document.
		await openView('ruled-site-2', `${site}/`, { session: 'ruled' });
		expect(await inView('ruled-site-2', `window.__start`)).toBe('replaced');
		await closeView('ruled-site-2');
		for (const { id } of await wv<{ id: string }[]>('listScripts')) await wv('unregisterScript', { id });
		expect(await wv('unregisterScript', { id: 'never-was' })).toBeNull();
		expect(await inView('site', `window.__start`)).toBe('replaced');
		await go('site', `${site}/scripts?3`);
		expect(await inView('site', `window.__start ?? 'nothing'`)).toBe('nothing');
		expect(await inView('site', `document.documentElement.dataset.isolated ?? 'nothing'`)).toBe('nothing');
		await closeView('ruled-site');
		await s('remove', { session: 'ruled' });
		await closeView('site');
	}, 90_000);

	// ── input policy ───────────────────────────────────────────────────────

	check('input policy: a real key doesn\'t reach the page, and beforeInput says so', async () => {
		const title = 'E2E sessions window';
		const press = async (...keys: number[]) => {
			await win('keys', { title, keys });
			await Bun.sleep(350);
		};
		const keys = () => app.eval<string[]>(`window.__keys.splice(0)`);
		await app.eval(`(() => { window.__keys = []; addEventListener('pointerdown', (e) => { window.__mouse = [e.clientX, e.clientY, e.target.tagName + '#' + e.target.id]; }, true); addEventListener('keydown', (e) => __keys.push(e.key + (e.ctrlKey ? '+ctrl' : '') + (e.shiftKey ? '+shift' : '') + (e.altKey ? '+alt' : '')), true); addEventListener('keyup', (e) => __keys.push('up:' + e.key), true); const d = document.createElement('div'); d.id = 'e2e-cover'; d.style.cssText = 'position:fixed;inset:0;z-index:99999'; document.body.append(d); })()`);
		await win('click', { title, dx: 400, dy: 300 }); // the page has the keyboard
		await app.eval(`document.querySelector('#e2e-cover')?.remove()`);
		await Bun.sleep(300);
		expect(await wv('getInputPolicy', { windowId: 0 })).toEqual({ monitorInstalled: true, intercept: [], menuShortcuts: true });
		await until('the page has the keyboard', async () => {
			await press(0x58); // x
			return (await keys()).includes('x');
		}, 15_000);

		for (const args of [{ intercept: 3 }, { menuShortcuts: 'no' }, { intercept: [3] }, { intercept: [{ key: '' }] }, { intercept: [{ key: 'k', modifiers: 'shift' }] }, { intercept: [{ key: 'k', modifiers: ['hyper'] }] }, { intercept: [{ key: 'Nonsense', modifiers: ['control'] }] }, { intercept: [{ key: 'k' }] }, { intercept: [{ key: 'k', modifiers: ['shift'] }] }, { intercept: [{ key: 'Enter' }] }, { intercept: [{ key: 'Tab' }] }, { intercept: [{ key: 'Space', modifiers: ['shift'] }] }, { intercept: [{ key: 'Backspace' }] }])
			expect({ args, code: await code('webview', 'setInputPolicy', { windowId: 0, ...args }) }).toEqual({ args, code: 'invalid_args' });
		expect(await code('webview', 'setInputPolicy', { windowId: 999 })).toBe('unavailable');
		expect(await code('webview', 'getInputPolicy', { windowId: 999 })).toBe('unavailable');

		expect(await wv('setInputPolicy', { windowId: 0, intercept: [{ key: 'k', modifiers: ['control', 'shift'] }, { key: 'Escape' }, { key: 'F7' }, { key: 'ArrowLeft' }, { key: 'j', modifiers: ['alt'] }, { key: 'Enter', modifiers: ['control'] }, { key: 'Delete' }, { key: 'Home' }, { key: 'PageDown' }, { key: 'Insert' }, { key: 'ArrowRight', modifiers: ['shift'] }] })).toEqual({ monitorInstalled: true, interceptCount: 11, menuShortcuts: true });
		const got = await wv<{ intercept: { key: string; modifiers: string[] }[] }>('getInputPolicy', { windowId: 0 });
		expect(got.intercept[0]).toEqual({ key: 'k', modifiers: ['control', 'shift'] });
		expect(got.intercept[1]).toEqual({ key: 'Escape', modifiers: [] });

		let down = app.nextEvent('beforeInput', (e: { key: string; type: string }) => e.key === 'k' && e.type === 'keyDown', 10_000);
		await press(0x11, 0x10, 0x4b); // Ctrl+Shift+K
		expect(await down).toEqual({ windowId: 0, key: 'k', keyCode: 0x4b, type: 'keyDown', isAutoRepeat: false, modifiers: ['control', 'shift'], intercepted: true });
		expect((await keys()).filter((k) => k.toLowerCase().startsWith('k') || k.toLowerCase().startsWith('up:k'))).toEqual([]);
		// Modifiers must match exactly, and no event for those.
		await press(0x11, 0x4b); // Ctrl+K
		expect((await keys()).some((k) => k.startsWith('k'))).toBe(true);
		await press(0x4b); // k
		expect(await keys()).toContain('k');
		// Named keys, on their own or with Shift; a key's release too.
		for (const [key, vk, dom] of [['Escape', [0x1b], 'Escape'], ['F7', [0x76], 'F7'], ['ArrowLeft', [0x25], 'ArrowLeft'], ['Delete', [0x2e], 'Delete'], ['Home', [0x24], 'Home'], ['PageDown', [0x22], 'PageDown'], ['Insert', [0x2d], 'Insert'], ['ArrowRight', [0x10, 0x27], 'ArrowRight']] as const) {
			down = app.nextEvent('beforeInput', (e: { key: string; type: string }) => e.key === key && e.type === 'keyDown', 10_000);
			const up = app.nextEvent('beforeInput', (e: { key: string; type: string }) => e.key === key && e.type === 'keyUp', 10_000);
			await press(...vk);
			await down;
			await up;
			expect((await keys()).filter((k) => k.includes(dom))).toEqual([]);
		}
		// Alt, which Windows sends as a system key.
		down = app.nextEvent('beforeInput', (e: { key: string; type: string }) => e.key === 'j' && e.type === 'keyDown', 10_000);
		await press(0x12, 0x4a);
		await down;
		expect((await keys()).filter((k) => k.toLowerCase().startsWith('j'))).toEqual([]);

		// A key that makes a character is fine with Control.
		down = app.nextEvent('beforeInput', (e: { key: string; type: string }) => e.key === 'Enter' && e.type === 'keyDown', 10_000);
		await press(0x11, 0x0d);
		await down;
		expect((await keys()).filter((k) => k.includes('Enter'))).toEqual([]);

		// What a page hears, marked as its own window's.
		await app.eval(`(() => { window.__heard = []; window.__stopHearing = host.webview.onBeforeInput((e) => __heard.push(e)); })()`);
		await press(0x11, 0x10, 0x4b);
		expect((await app.eval<{ target: boolean }[]>(`window.__heard`)).some((e) => e.target === true)).toBe(true);
		await app.eval(`window.__stopHearing()`);
	}, 90_000);

	check('input policy: a rule comes before the menu, menuShortcuts false keeps accelerators from running', async () => {
		const title = 'E2E sessions window';
		const press = async (...keys: number[]) => {
			await win('keys', { title, keys });
			await Bun.sleep(400);
		};
		const previous = await op<unknown>('menu', 'getAppMenu').catch(() => []);
		await op('menu', 'setAppMenu', { menus: [{ name: 'E2E', items: [{ label: 'Hello', id: 'e2e-hello', accelerator: 'Ctrl+Shift+F8' }, { label: 'Ruled', id: 'e2e-ruled', accelerator: 'Ctrl+Shift+F9' }] }] });
		const menu = (id: string, ms = 1500) => app.nextEvent('menuAction', (e: { id: string }) => e.id === id, ms).then(() => true, () => false);
		try {
			await wv('setInputPolicy', { windowId: 0 });
			let ran = menu('e2e-hello', 8000);
			await press(0x11, 0x10, 0x77); // Ctrl+Shift+F8
			expect(await ran).toBe(true);
			await wv('setInputPolicy', { windowId: 0, intercept: [{ key: 'F9', modifiers: ['control', 'shift'] }] });
			ran = menu('e2e-ruled');
			await press(0x11, 0x10, 0x78);
			expect(await ran).toBe(false);
			expect(await wv('setInputPolicy', { windowId: 0, menuShortcuts: false, intercept: [{ key: 'F10', modifiers: ['control'] }] })).toEqual({ monitorInstalled: true, interceptCount: 1, menuShortcuts: false });
			expect(await wv('getInputPolicy', { windowId: 0 })).toMatchObject({ menuShortcuts: false });
			await app.eval(`window.__keys.length = 0`);
			ran = menu('e2e-hello');
			await press(0x11, 0x10, 0x77);
			expect(await ran).toBe(false);
			expect((await app.eval<string[]>(`window.__keys.splice(0)`)).some((k) => k.startsWith('F8'))).toBe(true);
			// Rules still hold.
			const down = app.nextEvent('beforeInput', (e: { key: string; type: string }) => e.key === 'F10' && e.type === 'keyDown', 10_000);
			await press(0x11, 0x79);
			await down;
			// Cleared, as it was.
			expect(await wv('setInputPolicy', { windowId: 0 })).toEqual({ monitorInstalled: true, interceptCount: 0, menuShortcuts: true });
			ran = menu('e2e-hello', 8000);
			await press(0x11, 0x10, 0x77);
			expect(await ran).toBe(true);
		} finally {
			await wv('setInputPolicy', { windowId: 0 }).catch(() => {});
			await op('menu', 'setAppMenu', { menus: Array.isArray(previous) ? previous : [] }).catch(() => {});
		}
	}, 60_000);

	// ── across a relaunch ──────────────────────────────────────────────────

	check('a persistent session across a relaunch: its cookie is there; removed, it isn\'t; its profile goes', async () => {
		const expires = Math.floor(Date.now() / 1000) + 3600;
		await s('create', { id: 'lasting', persistent: true });
		await s('cookiesSet', { session: 'lasting', url: `${site}/`, name: 'kept', value: 'across', expires });
		await s('create', { id: 'lasting-proxied', persistent: true });
		await s('setProxy', { session: 'lasting-proxied', proxy: { type: 'http', host: '127.0.0.1', port: 9 } });
		await s('cookiesSet', { session: 'lasting-proxied', url: `${site}/`, name: 'kept', value: 'proxied', expires });
		await s('create', { id: 'lasting-private', persistent: false });
		await s('cookiesSet', { session: 'lasting-private', url: `${site}/`, name: 'kept', value: 'private', expires });
		const saved = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA!, 'dev.kitop.notes', 'sessions.json'), 'utf8'));
		const profile = saved.lasting.profile as string;
		const profiles = join(process.env.LOCALAPPDATA!, 'dev.kitop.notes', 'WebView2', 'EBWebView');
		const profileDir = join(profiles, `WV2Profile_${profile}`);
		await Bun.sleep(1500); // cookies reach the disk
		expect(existsSync(profileDir)).toBe(true);
		await app.close();
		await stopLeftovers();

		app = await launch({ app: APP, timeout: 90_000, env: { NOTES_PROTOCOL_CONTROL: `http://127.0.0.1:${control.port}` } });
		await app.waitFor('#counter', { timeout: 30_000 });
		// Not listed until opened.
		expect((await s<{ id: string }[]>('list')).map((x) => x.id)).toEqual(['default']);
		await s('create', { id: 'lasting', persistent: true });
		expect((await s('cookiesGet', { session: 'lasting', url: `${site}/`, name: 'kept' }))[0]?.value).toBe('across');
		// A session with its own environment comes back to it, without the proxy until it's set again.
		await s('create', { id: 'lasting-proxied', persistent: true });
		expect((await s('cookiesGet', { session: 'lasting-proxied', url: `${site}/`, name: 'kept' }))[0]?.value).toBe('proxied');
		expect(await s('getProxy', { session: 'lasting-proxied' })).toBeNull();
		await s('create', { id: 'lasting-private', persistent: false });
		expect(await s('cookiesGet', { session: 'lasting-private', url: `${site}/` })).toEqual([]);
		await s('remove', { session: 'lasting' });
		await s('remove', { session: 'lasting-proxied' });
		await s('remove', { session: 'lasting-private' });
		expect(await s('list')).toEqual([{ id: 'default', persistent: true }]);
		await app.close();
		await stopLeftovers();

		app = await launch({ app: APP, timeout: 90_000, env: { NOTES_PROTOCOL_CONTROL: `http://127.0.0.1:${control.port}` } });
		await app.waitFor('#counter', { timeout: 30_000 });
		await s('create', { id: 'lasting', persistent: true });
		expect(await s('cookiesGet', { session: 'lasting', url: `${site}/` })).toEqual([]);
		// The folder is gone, and what private sessions left of theirs: only this new one is there.
		expect(existsSync(profileDir)).toBe(false);
		const fresh = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA!, 'dev.kitop.notes', 'sessions.json'), 'utf8')).lasting.profile as string;
		expect(readdirSync(profiles).filter((x) => x.startsWith('WV2Profile_'))).toEqual([`WV2Profile_${fresh}`]);
		await s('remove', { session: 'lasting' });
	}, 240_000);
});
