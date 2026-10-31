// The iOS app (thin client: WKWebView on the SvelteKit server) on a booted simulator:
//   SVELTE_DESKTOP_TARGET=ios SVELTE_DESKTOP_IOS_SERVER_URL=http://127.0.0.1:5199 bunx --bun vite build
//   bun run test:ios
// Starts `vite dev` (no desktop window) as the server. Skipped unless IOS_E2E is set.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

describe.skipIf(!process.env.IOS_E2E)('ios', () => {
	let app: AppHandle;
	let dev: ReturnType<typeof Bun.spawn> | undefined;
	const port = 5300 + Math.floor(Math.random() * 500);
	const serverUrl = `http://127.0.0.1:${port}`;

	beforeAll(async () => {
		dev = Bun.spawn(['bunx', '--bun', 'vite', 'dev', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
			env: { ...process.env, SVELTE_DESKTOP_NO_WINDOW: '1' },
			stdout: 'ignore',
			stderr: 'ignore'
		});
		for (let i = 0; i < 200; i++) {
			if (await fetch(serverUrl).then((r) => r.ok, () => false)) break;
			await Bun.sleep(100);
		}
		app = await launch({ ios: { serverUrl, udid: process.env.IOS_UDID }, timeout: 60_000 });
		await app.waitFor('#counter', { timeout: 20_000 });
	});
	afterAll(async () => {
		await app?.close();
		dev?.kill();
	});

	test('the SvelteKit app loads from the server, remote command works', async () => {
		const before = Number(await app.text('#counter'));
		await app.click('button:not([type=button])');
		await app.waitFor(new Function(`return Number(document.querySelector('#counter')?.textContent) > ${before}`) as () => boolean);
	});

	test('page → host bridge: platform stores render', async () => {
		await app.goto('/platform');
		await app.waitFor(() => /· ios/.test(document.querySelector('[data-testid=identity]')?.textContent ?? ''), { timeout: 10_000 });
		expect(await app.text('[data-testid=identity]')).toContain('Svelte Notes 0.1.0 · ios');
		await app.goto('/');
	});

	test('frames cannot call native', async () => {
		// webkit.messageHandlers exists in every frame; the host answers the main frame only.
		let got = false;
		const ev = app.nextEvent<{ channel: string }>('message', (d) => d.channel === 'from-frame', 2000).then(() => (got = true), () => {});
		await app.eval(`(() => { const f = document.createElement('iframe'); f.srcdoc = "<script>webkit.messageHandlers.__shell__.postMessage(JSON.stringify({t:'call',req:{id:1,service:'events',op:'emit',args:{channel:'from-frame'}}}))<\\/script>"; document.body.appendChild(f); setTimeout(() => f.remove(), 1500); })()`);
		await ev;
		expect(got).toBe(false);
	});

	test('app, system, theme', async () => {
		expect(await app.platform('app', 'getInfo')).toMatchObject({ platform: 'ios', identifier: 'dev.svelte-desktop.notes', serverUrl });
		expect(await app.platform('system', 'info')).toMatchObject({ os: 'ios', family: 'ios' });
		expect(['light', 'dark']).toContain((await app.platform<{ appearance: string }>('theme', 'get')).appearance);
	});

	test('clipboard round trip', async () => {
		await app.platform('clipboard', 'writeText', { text: 'from the iOS test' });
		expect(await app.platform<string>('clipboard', 'readText')).toBe('from the iOS test');
	});

	test('secure storage (Keychain)', async () => {
		const k = { service: 'e2e', account: 'me' };
		await app.platform('secureStorage', 'setPassword', { ...k, password: 's3cret ✓' });
		expect(await app.platform<string>('secureStorage', 'getPassword', k)).toBe('s3cret ✓');
		await app.platform('secureStorage', 'deletePassword', k);
		expect(await app.platform<string | null>('secureStorage', 'getPassword', k)).toBeNull();
	});

	test('error codes', async () => {
		expect(await app.platform('tray', 'create', {}).catch((e: unknown) => e)).toMatchObject({ code: 'unsupported' });
		expect(await app.platform('clipboard', 'readImage').catch((e: unknown) => e)).toMatchObject({ code: 'unsupported' });
		expect(await app.platform('nope', 'x').catch((e: unknown) => e)).toMatchObject({ code: 'unknown' });
		expect(await app.platform('app', 'getPath', { name: 'bogus' }).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
	});

	test('events and haptics', async () => {
		const got = app.nextEvent<{ channel: string; data: unknown }>('message', (d) => d.channel === 'e2e');
		await app.platform('events', 'emit', { channel: 'e2e', data: { n: 2 } });
		expect((await got).data).toEqual({ n: 2 });
		expect(await app.platform('haptics', 'impact', { style: 'light' })).toBe(true);
	});

	test('notifications permission status', async () => {
		const s = await app.platform<{ status: string }>('notifications', 'getPermissionStatus');
		expect(['notDetermined', 'denied', 'granted']).toContain(s.status);
	});

	test('notifications: show/replace/list, schedule, deep link on tap, reply, cold-start claim, push', async () => {
		await app.goto('/');
		await app.waitFor('#counter');
		const status = (await app.platform<{ status: string }>('notifications', 'getPermissionStatus')).status;
		const shown = await app.eval<{ id?: string; code?: string }>(`host.notifications.show({ id: 'ios-1', title: 'iOS', body: 'one', url: '/about', data: { n: 1 } }).then((r) => r, (e) => ({ code: e.code }))`);
		if (status !== 'granted') {
			// Not allowed yet on this simulator: the system refuses to post (allow once in the app).
			expect(shown.id ?? shown.code).toBeTruthy();
			return;
		}
		expect(shown).toMatchObject({ id: 'ios-1', scheduled: false });
		await app.eval(`host.notifications.show({ id: 'ios-1', title: 'iOS', body: 'two', url: '/about', data: { n: 2 } })`);
		const delivered = (await app.eval<{ id: string; body: string; data?: unknown }[]>('host.notifications.delivered()')).filter((n) => n.id === 'ios-1');
		expect(delivered).toEqual([expect.objectContaining({ body: 'two', url: '/about', data: { n: 2 } })]);
		const at = Date.now() + 60_000;
		await app.eval(`host.notifications.show({ id: 'ios-later', title: 'Later', at: ${at}, repeat: 'hour' })`);
		expect((await app.eval<{ id: string; repeat?: string }[]>('host.notifications.pending()')).find((p) => p.id === 'ios-later')).toMatchObject({ repeat: 'hour' });
		await app.eval(`host.notifications.cancel('ios-later')`);

		await app.platform('notifications', 'simulateResponse', { id: 'ios-1' });
		await app.waitFor(() => location.pathname === '/about', { timeout: 5000 });
		await app.waitFor(() => /click ios-1/.test(document.querySelector('#notification-log')?.textContent ?? ''));
		await app.eval(`host.notifications.show({ id: 'ios-chat', title: 'Alice', actions: [{ id: 'reply', title: 'Reply', input: true }] })`);
		await app.platform('notifications', 'simulateResponse', { id: 'ios-chat', actionId: 'reply', input: 'yes' });
		await app.waitFor(() => /reply ios-chat reply: yes/.test(document.querySelector('#notification-log')?.textContent ?? ''));
		// Cold start: kept until the next page claims it.
		await app.goto('/');
		await app.waitFor('#counter');
		await app.platform('notifications', 'simulateResponse', { id: 'ios-1', cold: true });
		await app.eval('(location.reload(), true)');
		await app.waitFor(() => location.pathname === '/about', { timeout: 15_000 });

		await app.eval('host.notifications.setBadge(2)');
		await app.eval('host.notifications.setBadge(0)');
		await app.eval('host.notifications.dismissAll()');
		expect(await app.eval('host.notifications.delivered()')).toEqual([]);
		// APNs on the simulator (push.apns → aps-environment development): a device token, or a clear error.
		const push = await app.eval<{ provider?: string; token?: string; code?: string }>(`host.push.register().then((t) => t, (e) => ({ code: e.code, message: e.message }))`);
		if (!push.provider) return expect(push.code).toBe('unavailable');
		expect(push).toMatchObject({ provider: 'apns', topic: 'dev.svelte-desktop.notes', environment: 'development' });
		// A remote push in the foreground (simctl push = what APNs delivers): pushMessage + shown,
		// and a tap on it deep-links like a local one (url from the `sd` payload).
		await app.goto('/');
		await app.waitFor('#counter');
		const received = app.nextEvent<{ id: string; payload?: string; notification?: { title: string } }>('pushMessage');
		const file = `/tmp/sd-push-${Date.now()}.apns`;
		await Bun.write(file, JSON.stringify({ 'Simulator Target Bundle': 'dev.svelte-desktop.notes', aps: { alert: { title: 'Pushed', body: 'from APNs' } }, sd: JSON.stringify({ url: '/about', data: { push: true } }) }));
		await Bun.$`xcrun simctl push ${process.env.IOS_UDID ?? 'booted'} dev.svelte-desktop.notes ${file}`.quiet();
		const message = await received;
		expect(message.notification?.title).toBe('Pushed');
		expect(JSON.parse(message.payload!)).toEqual({ url: '/about', data: { push: true } });
		const pushed = await app.eval<{ id: string; data?: unknown }[]>('host.notifications.delivered()');
		expect(pushed.find((n) => n.id === message.id)).toMatchObject({ title: 'Pushed', url: '/about', data: { push: true } });
		await app.platform('notifications', 'simulateResponse', { id: message.id });
		await app.waitFor(() => location.pathname === '/about', { timeout: 5000 });
		await app.eval('host.notifications.dismissAll()');
	});

	// Real APNs (sandbox) to this simulator — opt-in, needs an APNs auth key of the team that owns the bundle id:
	//   APNS_KEY=path/AuthKey.p8 APNS_KEY_ID=… APNS_TEAM_ID=… bun run test:ios
	test.skipIf(!process.env.APNS_KEY)('real APNs push: createPush() → Apple sandbox → this simulator → pushMessage', async () => {
		const { createPush } = await import('@svelte-desktop/shell/push');
		await app.goto('/');
		await app.waitFor('#counter');
		const target = await app.eval<{ provider: 'apns'; token: string; topic: string; environment: 'development' }>('host.push.register()');
		const received = app.nextEvent<{ id: string; payload?: string }>('pushMessage', undefined, 30_000);
		const push = createPush({ apns: { teamId: process.env.APNS_TEAM_ID!, keyId: process.env.APNS_KEY_ID!, key: await Bun.file(process.env.APNS_KEY!).text() } });
		await push.send(target, { id: 'apns-e2e', title: 'Real APNs', body: 'sandbox', url: '/about' });
		const m = await received;
		expect(m.id).toBe('apns-e2e'); // apns-collapse-id became the notification id
		expect(JSON.parse(m.payload!)).toEqual({ url: '/about' });
		push.close();
	});

	test('notifications.show conformance fixtures (native/notifications.fixtures.json)', async () => {
		const fx = await Bun.file(new URL('../../../packages/shell/native/notifications.fixtures.json', import.meta.url)).json();
		const withTime = (a: Record<string, unknown>) => (typeof a.at === 'number' ? { ...a, at: Date.now() + a.at } : a);
		for (const c of fx.valid) {
			const r = await app.platform<{ id: string; scheduled?: boolean }>('notifications', 'show', withTime(c.args)).catch((e: unknown) => e);
			expect({ name: c.name, r }).toMatchObject({ name: c.name, r: { id: c.args.id, scheduled: !!c.scheduled } });
		}
		for (const c of fx.invalid) {
			const e = await app.platform('notifications', 'show', withTime(c.args)).then(() => null, (err: { code?: string }) => err);
			expect({ name: c.name, code: (e as { code?: string } | null)?.code }).toEqual({ name: c.name, code: 'invalid_args' });
		}
		await app.platform('notifications', 'dismissAll');
	});

	test('Swift plugin (native/ios/Device.swift)', async () => {
		expect(await app.platform('device', 'info')).toMatchObject({ idiom: 'phone' });
		expect(await app.platform<number>('device', 'multiply', { a: 6, b: 7 })).toBe(42);
		expect(await app.platform('device', 'multiply', {}).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
		const pong = app.nextEvent<{ at: number }>('device.pong');
		expect(await app.platform('device', 'ping')).toBe(true);
		expect((await pong).at).toBeGreaterThan(0);
	});

	test('permissions: declared in desktop.config, status from the OS', async () => {
		expect(await app.eval<Record<string, string>>('host.permissions.declared()')).toMatchObject({ camera: 'Notes can attach photos from your camera.' });
		expect(['granted', 'denied', 'notDetermined']).toContain(await app.eval<string>("host.permissions.status('camera')"));
		expect(await app.eval<string>("host.permissions.request('microphone').then(() => 'ok', (e) => e.code)")).toBe('undeclared');
	});

	test('screenshot', async () => {
		const png = await app.screenshot();
		expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
	});
});
