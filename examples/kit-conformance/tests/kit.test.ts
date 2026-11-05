// SvelteKit feature matrix in the real desktop shell — built app (`bun run test`) or
// `vite dev` (`bun run test:dev`). Requests go through the shell's loopback gate.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

let app: AppHandle;
const dev = !!process.env.DESKTOP_TEST_DEV;
beforeAll(async () => {
	app = await launch(dev ? { dev: true, env: { CONFORMANCE_SECRET: 's3cret' } } : { env: { CONFORMANCE_SECRET: 's3cret' } });
	await app.waitFor('#home');
});
afterAll(() => app?.close());

/** fetch from inside the page (same origin, session cookie): {status, headers, text}. */
const req = (path: string, init: RequestInit = {}) =>
	app.eval<{ status: number; headers: Record<string, string>; text: string; redirected: boolean; url: string }>(
		`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, redirected: r.redirected, url: r.url, headers: Object.fromEntries(r.headers), text: await r.text() }))`
	);
const until = (fn: () => boolean) => app.waitFor(fn, { timeout: 10_000 });
const textOf = (sel: string) => app.text(sel);
/** Full-page navigation (not client-side). */
const load = async (path: string) => {
	await app.eval(`location.href = ${JSON.stringify(path)}`);
	await Bun.sleep(300);
	await app.waitFor(() => document.readyState === 'complete' && document.documentElement.hasAttribute('data-desktop-hydrated'), { timeout: 10_000 });
};

test('static assets: text, JSON, SVG (with content types)', async () => {
	const txt = await req('/hello.txt');
	expect([txt.status, txt.text]).toEqual([200, 'hello static\n']);
	expect(txt.headers['content-type']).toContain('text/plain');
	const json = await req('/data.json');
	expect(JSON.parse(json.text)).toEqual({ static: true });
	expect((await req('/dot.svg')).headers['content-type']).toContain('image/svg+xml');
	expect(await app.eval<number>(`(async () => { const i = document.querySelector('#static-img'); await i.decode(); return i.naturalWidth; })()`)).toBe(8);
});

test('hooks: handle (locals, headers, transformPageChunk)', async () => {
	const home = await req('/');
	expect(home.headers['x-conformance-hook']).toBe('1');
	expect(home.text).toContain('content="transformed"');
});

test('SSR: +layout.server, +page.server, +page.ts (fetch in load), $lib/server, $env/dynamic, setHeaders, streaming', async () => {
	const html = await req('/load?q=ssr');
	expect(html.headers['x-load-header']).toBe('set');
	expect(html.text).toContain('from +page.server.ts');
	expect(html.text).toContain('server-only value');
	await load('/load?q=nav');
	expect(await textOf('#layout')).toBe('from +layout.server.ts');
	expect(await textOf('#server')).toBe('from +page.server.ts');
	expect(await textOf('#universal')).toBe('from +page.ts');
	expect(await textOf('#fetched')).toBe('universal-load');
	expect(await textOf('#hook')).toBe('true');
	expect(await textOf('#query')).toBe('nav');
	expect(await textOf('#env')).toBe('s3cret');
	await until(() => document.querySelector('#streamed')?.textContent === 'streamed value');
});

test('client-side navigation, page state and history', async () => {
	await load('/');
	await app.goto('/load?q=client');
	expect(await textOf('#query')).toBe('client');
	expect(await textOf('#url')).toBe('/load');
	await app.eval('history.back()');
	await until(() => location.pathname === '/');
	await app.goto('/params/hello/world');
	expect(JSON.parse(await textOf('#params'))).toEqual({ slug: 'hello', optional: 'world' });
	await app.goto('/params/only');
	expect(JSON.parse(await textOf('#params'))).toEqual({ slug: 'only' });
	await app.goto('/rest/a/b/c');
	expect(await textOf('#rest')).toBe('a/b/c');
	await app.goto('/match/42');
	expect(await textOf('#matched')).toBe('42');
	await app.goto('/grouped');
	expect(await textOf('#grouped')).toBe('inside a (group)');
});

test('param matchers reject, unknown routes 404 with the error page', async () => {
	expect((await req('/match/abc')).status).toBe(404);
	await load('/nope/nowhere');
	expect(await textOf('#error-status')).toBe('404');
});

test('redirect() and error() from load, handleError for thrown errors', async () => {
	const r = await req('/redirect');
	expect(r.redirected).toBe(true);
	expect(new URL(r.url).search).toBe('?q=redirected');
	await load('/error');
	expect(await textOf('#error-status')).toBe('418');
	expect(await textOf('#error-message')).toBe('teapot');
	await load('/crash');
	expect(await textOf('#error-status')).toBe('500');
	expect(await textOf('#error-message')).toBe('handled: boom');
});

test('form actions with use:enhance: default (cookie), named, fail(), redirect()', async () => {
	await load('/actions');
	const submit = (id: string, field?: string, value?: string) =>
		app.eval(`(() => { const f = document.querySelector('#${id}'); ${field ? `f.querySelector('[name=${field}]').value = ${JSON.stringify(value)};` : ''} f.requestSubmit(); })()`);
	await submit('save', 'name', 'Ada');
	await until(() => document.querySelector('#form-result')?.textContent?.includes('Ada') ?? false);
	await until(() => document.querySelector('#cookie-name')?.textContent === 'Ada'); // load re-ran with the HttpOnly cookie
	await submit('echo', 'text', 'hi');
	await until(() => document.querySelector('#form-result')?.textContent === '{"echo":"hi"}');
	await submit('invalid');
	await until(() => document.querySelector('#form-result')?.textContent === '{"missing":true}');
	await submit('go');
	await until(() => location.pathname === '/load' && document.querySelector('#query')?.textContent === 'from-action');
});

test('form actions without JavaScript (plain POST → page)', async () => {
	const body = new URLSearchParams({ text: 'no-js' }).toString();
	const r = await req('/actions?/echo', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: '' } as any });
	expect(r.status).toBe(200);
	expect(r.text).toContain('no-js');
});

test('+server.ts: GET/POST JSON, status, setHeaders, cookies, origin/protocol', async () => {
	const g = await req('/api/echo?a=1');
	expect(g.headers['x-echo']).toBe('yes');
	const gj = JSON.parse(g.text);
	expect(gj.query).toEqual({ a: '1' });
	expect(gj.protocol).toBe('http:');
	expect(gj.origin).toBe(await app.eval<string>('location.origin'));
	const p = await req('/api/echo', { method: 'POST', body: JSON.stringify({ visitor: 'grace' }), headers: { 'content-type': 'application/json' } });
	expect(p.status).toBe(201);
	expect(JSON.parse((await req('/api/echo')).text).visitor).toBe('grace');
});

test('streaming responses arrive chunk by chunk', async () => {
	const r = await app.eval<{ chunks: number; text: string }>(`(async () => {
		const res = await fetch('/api/stream'); const reader = res.body.getReader(); let chunks = 0, text = '';
		for (;;) { const { done, value } = await reader.read(); if (done) break; chunks++; text += new TextDecoder().decode(value); }
		return { chunks, text }; })()`);
	expect(r.text).toBe('chunk0\nchunk1\nchunk2\nchunk3\nchunk4\n');
	expect(r.chunks).toBeGreaterThanOrEqual(2);
});

test('file upload: 20 MB multipart body', async () => {
	const r = await app.eval<{ name: string; size: number; sum: number }>(`(async () => {
		const bytes = new Uint8Array(20 * 1024 * 1024); for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
		const fd = new FormData(); fd.append('file', new File([bytes], 'big.bin'));
		const r = await fetch('/api/upload', { method: 'POST', body: fd }); return r.ok ? r.json() : { status: r.status }; })()`);
	expect(r).toMatchObject({ name: 'big.bin', size: 20 * 1024 * 1024 });
});

test('long requests (> 10 s) are not cut by an idle timeout', async () => {
	const r = await req('/api/slow?ms=12000');
	expect([r.status, JSON.parse(r.text)]).toEqual([200, { waited: 12000 }]);
}, 30_000);

test('remote functions: query, query.batch, command + refresh, form, getRequestEvent cookies, prerender', async () => {
	await load('/remote');
	expect(await textOf('#greet')).toBe('hello desktop');
	expect(JSON.parse(await textOf('#batch'))).toEqual([{ value: 2, batchSize: 3 }, { value: 4, batchSize: 3 }, { value: 6, batchSize: 3 }]);
	expect(JSON.parse(await textOf('#prerender'))).toEqual({ prerendered: true });
	const before = Number(await textOf('#bumped'));
	await app.click('#bump');
	await until(() => Number(document.querySelector('#bumped')?.textContent) > 0);
	expect(Number(await textOf('#bumped'))).toBe(before + 1);
	await app.eval(`(() => { const f = document.querySelector('#rename'); const i = f.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Lovelace'); i.dispatchEvent(new Event('input', { bubbles: true })); f.requestSubmit(); })()`);
	await until(() => document.querySelector('#rename-result')?.textContent === '{"renamed":"Lovelace"}');
	await load('/remote');
	expect(await textOf('#whoami')).toBe('Lovelace');
});

test('long remote command (> 10 s)', async () => {
	await load('/remote');
	await app.click('#slow');
	await app.waitFor(() => document.querySelector('#slow-result')?.textContent !== '', { timeout: 25_000 });
	expect(await textOf('#slow-result')).toBe('11000');
}, 40_000);

test('invalidate(dep) re-runs a universal load', async () => {
	await load('/invalidate');
	const n = Number(await textOf('#n'));
	await app.click('#again');
	// (predicates run in the page: values go in as source)
	await until(new Function(`return Number(document.querySelector('#n')?.textContent) === ${n + 1}`) as () => boolean);
});

test('shallow routing: pushState + page.state', async () => {
	await load('/shallow');
	await app.click('#push');
	await until(() => document.querySelector('#state')?.textContent === '{"modal":"open"}');
});

test('prerendered page', async () => {
	const r = await req('/prerendered');
	expect(r.status).toBe(200);
	expect(r.text).toContain('prerendered at build time');
	await load('/prerendered');
	expect(await textOf('#prerendered')).toBe('prerendered at build time');
});

test('the gate: pages need the session cookie (static build assets are public), Host is checked', async () => {
	const origin = await app.eval<string>('location.origin');
	expect((await fetch(`${origin}/hello.txt`)).status).toBe(200);
	if (dev) return; // vite dev serves Vite directly
	expect((await fetch(`${origin}/load`)).status).toBe(403);
	expect((await fetch(`${origin}/load`, { headers: { host: 'evil.example' } })).status).toBe(421);
});
