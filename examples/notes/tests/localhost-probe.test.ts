// A temporary probe, to decide whether the app could be served from <something>.localhost instead of
// 127.0.0.1: does each web view reach it, treat it as a secure context, and keep its cookies to it?
// It reports and asserts nothing about the answers. To be removed with the decision.
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { launch } from '@kitop/shell/test';

const log = (...a: unknown[]) => console.log('[probe]', ...a);

test('what a web view does with <something>.localhost', async () => {
	const seen: { port: number; host: string | null; cookie: string | null }[] = [];
	const serve = () =>
		Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(req, server) {
				seen.push({ port: server.port!, host: req.headers.get('host'), cookie: req.headers.get('cookie') });
				return new Response('<!doctype html><title>probe</title><p>probe</p>', {
					headers: { 'content-type': 'text/html', 'set-cookie': 'probe=1; Path=/; HttpOnly; SameSite=Strict' },
				});
			},
		});
	const a = serve();
	const b = serve();
	const app = await launch(process.env.WINDOWS_APP ? { app: resolve(process.env.WINDOWS_APP), timeout: 90_000 } : { timeout: 90_000 });
	const js = (code: string) => app.platform<any>('view', 'executeJavaScript', { id: 'probe', code });
	const visit = async (url: string) => {
		const before = seen.length;
		const opened = await app
			.platform('view', 'navigate', { id: 'probe', url })
			.then(() => 'navigate ok', (e: { message?: string }) => `navigate refused: ${e?.message}`);
		for (let i = 0; i < 40 && seen.length === before; i++) await Bun.sleep(100);
		await Bun.sleep(300);
		const request = seen.slice(before);
		const page = await Promise.race([js('location.href').catch((e: { message?: string }) => `eval failed: ${e?.message}`), Bun.sleep(4000).then(() => 'eval timed out')]);
		log(url, { opened, page, requests: request.length, request: request[0] ?? null });
	};
	try {
		await app.waitFor('#counter', { timeout: 30_000 });
		await app.platform('view', 'create', { id: 'probe', windowId: 0, url: 'about:blank', bounds: { x: 10, y: 20, width: 400, height: 300 } });
		await Bun.sleep(500);

		const host = 'kitop-probe.localhost';
		await visit(`http://${host}:${a.port}/`);
		log('capabilities', await js(`(async () => {
			let storage = null;
			try { localStorage.setItem('p', '1'); storage = localStorage.getItem('p'); } catch (e) { storage = String(e); }
			return {
				origin: location.origin,
				isSecureContext,
				subtle: !!(crypto && crypto.subtle),
				storage,
				mediaDevices: !!navigator.mediaDevices,
				serviceWorker: 'serviceWorker' in navigator,
				clipboard: !!navigator.clipboard,
			};
		})()`));
		await visit(`http://${host}:${a.port}/again`); // the cookie comes back to its host
		await visit(`http://${host}:${b.port}/`); // the same name, another port
		await visit(`http://127.0.0.1:${b.port}/`); // what the app's cookie would no longer reach
		await visit(`http://localhost:${b.port}/`);
		await visit(`http://other-${host}:${b.port}/`);
		log('127.0.0.1, for comparison', await (async () => {
			await visit(`http://127.0.0.1:${a.port}/`);
			return js('({ origin: location.origin, isSecureContext })');
		})());
		expect(true).toBe(true);
	} finally {
		await app.close().catch(() => {});
		a.stop(true);
		b.stop(true);
	}
}, 120_000);
