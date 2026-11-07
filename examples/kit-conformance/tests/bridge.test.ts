// A closed bridge list, as a real app has one (desktop.config.ts), on every OS: the list is enforced
// natively, by code that's different on each. What a page can do, asked from the page.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

let app: AppHandle;
beforeAll(async () => {
	// On Windows, a camera for the frames below. It asks like a real one: no fake answer to the question.
	app = await launch({ ...(process.env.KIT_APP && { app: process.env.KIT_APP, timeout: 90_000 }), env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--use-fake-device-for-media-stream' } });
	await app.waitFor('#home');
});
afterAll(() => app?.close());

const outcome = (call: string) => app.eval<string>(`${call}.then(() => 'ok', (e) => e.code)`);

test('an operation listed by name goes through', async () => {
	expect(await outcome('host.clipboard.readText()')).toBe('ok');
});

test('one not listed is refused, in the same service too, and the error names the rule', async () => {
	expect(await outcome(`host.clipboard.writeText('x')`)).toBe('denied');
	expect(await outcome(`host.app.getPath('userData')`)).toBe('denied');
	expect(await app.eval<string>(`host.app.getPath('userData').catch((e) => e.message)`)).toContain('bridge.allow');
});

test('service.* opens that service and no other', async () => {
	expect(await outcome('host.windows.getBounds()')).toBe('ok');
	expect(await outcome('host.windows.isMinimized()')).toBe('ok');
	expect(await outcome('host.screen.getAllDisplays()')).toBe('denied');
});

test('server code is not limited by it', async () => {
	expect(await app.platform<string>('app', 'getPath', { name: 'userData' })).toContain('kit-conformance');
});

test('events.emit gives a page the store, and not the other files of the folder', async () => {
	const own = await app.platform<string>('app', 'getPath', { name: 'userData' });
	await app.eval(`(async () => { await host.store.load(); host.store.set('bridge', 1); await host.store.flush(); })()`);
	expect(JSON.parse(await Bun.file(`${own}/kitop-store.json`).text()).bridge).toBe(1);
	expect(await app.eval(`host.windowState.save().then((s) => s.bounds.width > 0)`)).toBe(true);
	const reply = await app.eval<{ ok: boolean; error?: string }>(`new Promise((resolve) => {
		const off = host.onBroadcast('appfile:reply', (m) => { off(); resolve(m); });
		host.broadcast('appfile:request', { op: 'write', dir: 'userData', name: 'web-permissions.json', text: '{}', nonce: 'n' });
	})`);
	expect(reply.ok).toBe(false);
	expect(await Bun.file(`${own}/web-permissions.json`).exists()).toBe(false);
});

// A frame of another origin in one of the app's pages, asking for the camera. macOS has no camera on
// a runner and asks about the frame's own origin anyway (platform_web_policy.mm).
const frames = process.platform === 'darwin' ? test.skip : test;
frames('a third-party frame and the camera', async () => {
	const inner = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(`<!doctype html><script>
			navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); parent.postMessage('stream', '*'); }, (e) => parent.postMessage(e.name, '*'));
		</script>`, { headers: { 'content-type': 'text/html' } })
	});
	const frame = (allow: string) => app.eval<string>(`new Promise((resolve) => {
		const f = document.createElement('iframe');
		addEventListener('message', (e) => { f.remove(); resolve(e.data); }, { once: true });
		setTimeout(() => { f.remove(); resolve('no answer'); }, 15000);
		f.allow = ${JSON.stringify(allow)};
		f.src = 'http://127.0.0.1:${inner.port}/';
		document.body.append(f);
	})`);
	const own = await app.eval<string>(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'stream'; }, (e) => e.name)`);
	const undelegated = await frame('');
	const delegated = await frame('camera');
	await app.eval(`location.href = '/widened'`);
	await Bun.sleep(500);
	await app.waitFor(() => document.readyState === 'complete');
	const widened = await frame('camera');
	inner.stop(true);
	console.log(JSON.stringify({ platform: process.platform, own, undelegated, delegated, widened }));
	expect(own).toBe('stream');
	expect(undelegated).not.toBe('stream');
});
