// The same app as an APK on an Android emulator/device, over adb:
//   SVELTE_DESKTOP_TARGET=android bunx --bun vite build && bun run test:android
// Skipped unless ANDROID_E2E is set (needs a booted emulator or a device).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

describe.skipIf(!process.env.ANDROID_E2E)('android', () => {
	let app: AppHandle;
	beforeAll(async () => {
		app = await launch({ android: { serial: process.env.ANDROID_SERIAL, install: !process.env.ANDROID_NO_INSTALL }, timeout: 60_000 });
		await app.waitFor('#counter', { timeout: 20_000 });
	});
	afterAll(() => app?.close());

	test('SSR in the APK sees the native layer (server → host over stdio)', async () => {
		expect(await app.text('body')).toContain('desktop shell');
		expect(await app.text('body')).toContain('/data/user/0/dev.svelte_desktop.notes/files/dev.svelte-desktop.notes');
	});

	test('remote command + bun:sqlite', async () => {
		const before = Number(await app.text('#counter'));
		await app.click('button:not([type=button])');
		await app.waitFor(new Function(`return Number(document.querySelector('#counter')?.textContent) > ${before}`) as () => boolean);
		expect(Number(await app.text('#counter'))).toBe(before + 1);
	});

	test('remote form adds a note', async () => {
		const note = `android note ${Date.now()}`;
		await app.fill('input[name^=text]', note);
		await app.press('input[name^=text]', 'Enter');
		await app.waitFor(new Function(`return document.body.innerText.includes(${JSON.stringify(note)})`) as () => boolean);
	});

	test('page → host bridge (WebMessagePort): platform stores render', async () => {
		await app.goto('/platform');
		await app.waitFor(() => /android/.test(document.querySelector('[data-testid=identity]')?.textContent ?? ''), { timeout: 10_000 });
		expect(await app.text('[data-testid=identity]')).toContain('Svelte Notes 0.1.0 · android');
		await app.goto('/');
	});

	test('a frame cannot plant its own port', async () => {
		// An opaque-origin frame posts a fake __shell_port__ to the app page: the bridge
		// must ignore it (e.source is the frame) and keep the host's channel.
		const hijacked = await app.eval<boolean>(`new Promise((done) => {
			const f = document.createElement('iframe');
			f.sandbox = 'allow-scripts';
			f.srcdoc = "<script>const c = new MessageChannel(); c.port1.onmessage = () => parent.postMessage('hit', '*'); parent.postMessage('__shell_port__', '*', [c.port2]);<\\/script>";
			let hit = false;
			addEventListener('message', (e) => { if (e.data === 'hit') hit = true; });
			document.body.appendChild(f);
			setTimeout(() => { f.remove(); done(hit); }, 1500);
		})`);
		expect(hijacked).toBe(false);
		await app.goto('/platform');
		await app.waitFor(() => /android/.test(document.querySelector('[data-testid=identity]')?.textContent ?? ''), { timeout: 10_000 });
		await app.goto('/');
	});

	test('app, system, theme', async () => {
		const info = await app.platform<{ platform: string; identifier: string; arch: string }>('app', 'getInfo');
		expect(info).toMatchObject({ platform: 'android', identifier: 'dev.svelte-desktop.notes', arch: 'arm64' });
		expect(await app.platform<{ os: string; sdk: number }>('system', 'info')).toMatchObject({ os: 'android' });
		expect(['light', 'dark']).toContain((await app.platform<{ appearance: string }>('theme', 'get')).appearance);
	});

	test('clipboard round trip', async () => {
		await app.platform('clipboard', 'writeText', { text: 'from the test' });
		expect(await app.platform<string>('clipboard', 'readText')).toBe('from the test');
	});

	test('secure storage (Android Keystore)', async () => {
		const k = { service: 'e2e', account: 'me' };
		await app.platform('secureStorage', 'setPassword', { ...k, password: 's3cret ✓' });
		expect(await app.platform<string>('secureStorage', 'getPassword', k)).toBe('s3cret ✓');
		await app.platform('secureStorage', 'deletePassword', k);
		expect(await app.platform<string | null>('secureStorage', 'getPassword', k)).toBeNull();
	});

	test('error codes: unsupported vs unknown vs invalid_args', async () => {
		expect(await app.platform('tray', 'create', {}).catch((e: unknown) => e)).toMatchObject({ code: 'unsupported' });
		expect(await app.platform('clipboard', 'readImage').catch((e: unknown) => e)).toMatchObject({ code: 'unsupported' });
		expect(await app.platform('nope', 'x').catch((e: unknown) => e)).toMatchObject({ code: 'unknown' });
		expect(await app.platform('app', 'getPath', { name: 'bogus' }).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
	});

	test('events reach server code', async () => {
		const got = app.nextEvent<{ channel: string; data: unknown }>('message', (d) => d.channel === 'e2e');
		await app.platform('events', 'emit', { channel: 'e2e', data: { n: 1 } });
		expect((await got).data).toEqual({ n: 1 });
	});

	test('dialog: native message box, dismissed → cancelId', async () => {
		const adb = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
		const serial = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
		const appWindows = async () =>
			(await Bun.$`${adb} ${serial} shell dumpsys window windows`.quiet().nothrow().text()).split('\n').filter((l) => /Window #\d+ Window\{.*dev\.svelte_desktop\.notes/.test(l)).length;
		const base = await appWindows();
		const answer = app.platform<{ response: number; canceled: boolean }>('dialog', 'showMessageBox', { message: 'E2E', buttons: ['Yes', 'No'] });
		// The AlertDialog is its own window: wait for it, then dismiss it from the keyboard.
		for (let i = 0; i < 50 && (await appWindows()) <= base; i++) await Bun.sleep(100);
		expect(await appWindows()).toBe(base + 1);
		await Bun.$`${adb} ${serial} shell input keyevent KEYCODE_ESCAPE`.quiet();
		expect(await answer).toEqual({ response: 1, canceled: true });
		expect(await app.platform<string>('app', 'getName')).toBe('Svelte Notes'); // the activity is still there
	});

	test('C plugin (sd_host over JNI): ops, errors, events', async () => {
		expect(await app.platform<string>('counter', 'hello')).toBe('hello from C on Android');
		const changed = app.nextEvent<{ total: number }>('counterChanged');
		const total = await app.platform<number>('counter', 'add', { n: 5 });
		expect((await changed).total).toBe(total);
		expect(await app.platform<number>('counter', 'add', { n: 2 })).toBe(total + 2);
		expect(await app.platform('counter', 'add', {}).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
	});

	test('sidecar compiled from native/android/sidecars/hello.c runs from server code', async () => {
		const r = await app.eval<{ ok: boolean; code: number; out: string }>(`fetch('/api/sidecar?arg=e2e').then((r) => r.json())`);
		expect(r).toMatchObject({ ok: true, code: 0 });
		expect(r.out).toMatch(/^hello from an Android sidecar \(pid \d+\) e2e$/);
	});

	test('background job in its own process on the phone', async () => {
		const api = <T>(path: string, init?: RequestInit) => app.eval<T>(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then((r) => r.json())`);
		const job = await api<{ id: string }>('/api/jobs', { method: 'POST', body: JSON.stringify({ name: 'count', args: { to: 4, delay: 20 } }) });
		const done = await api<{ state: string; result: { counted: number; pid: number }; error?: string }>(`/api/jobs?id=${job.id}&wait=1`);
		expect(done).toMatchObject({ state: 'done', result: { counted: 4 } });
	});

	test('permissions: status from Android, undeclared error', async () => {
		expect(['granted', 'denied', 'notDetermined']).toContain(await app.eval<string>("host.permissions.status('camera')"));
		expect(await app.eval<string>("host.permissions.request('microphone').then(() => 'ok', (e) => e.code)")).toBe('undeclared');
	});

	describe('notifications (raw ops)', () => {
		const adb = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
		const serial = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
		const pkg = 'dev.svelte_desktop.notes';
		// adb shell joins its arguments into one remote command line: quote each for the device's sh.
		const sh = (...args: string[]) => Bun.$`${adb} ${serial} shell ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`.quiet().nothrow().text();
		// Shade taps need uiautomator, which can't run while another UiAutomation client (an
		// agent-device / Appium session) holds the device: those tests are skipped then.
		const uiAutomator = !!process.env.ANDROID_E2E && Bun.spawnSync([adb, ...serial, 'shell', 'uiautomator', 'dump', '/sdcard/sd-ui.xml']).exitCode === 0;
		const alarms = async () => (await sh('dumpsys', 'alarm')).split('\n').filter((l) => /^\s*tag=\*walarm\*:dev\.sveltedesktop\.NOTIFICATION_ALARM/.test(l)).length; // pending ones (not the history)
		type Delivered = { id: string; title: string; body: string; subtitle?: string; group?: string; payload?: string; date?: number };
		type Response = { seq: number; id: string; tag: string; kind: string; actionId: string | null; input: string | null; payload: string | null; target?: boolean };
		const n = <T = unknown>(op: string, args: Record<string, unknown> = {}) => app.platform<T>('notifications', op, args);
		const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> => {
			const end = Date.now() + ms;
			let v = await get();
			while (!ok(v) && Date.now() < end) {
				await Bun.sleep(150);
				v = await get();
			}
			return v;
		};
		const delivered = () => n<Delivered[]>('delivered');
		const deviceNow = () => app.eval<number>('Date.now()');
		// The notification shade, driven like a user: find a node by text / content-desc, tap it.
		const node = async (re: RegExp, ms = 6000) => {
			const end = Date.now() + ms;
			while (Date.now() < end) {
				await sh('uiautomator', 'dump', '/sdcard/sd-ui.xml');
				const xml = await sh('cat', '/sdcard/sd-ui.xml');
				for (const m of xml.matchAll(/<node [^>]*>/g)) {
					const text = /\btext="([^"]*)"/.exec(m[0])?.[1] ?? '';
					const desc = /content-desc="([^"]*)"/.exec(m[0])?.[1] ?? '';
					const hint = /\bhint="([^"]*)"/.exec(m[0])?.[1] ?? '';
					const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(m[0]);
					if (b && (re.test(text) || re.test(desc) || re.test(hint))) return { x: (Number(b[1]) + Number(b[3])) >> 1, y: (Number(b[2]) + Number(b[4])) >> 1, x1: Number(b[1]), x2: Number(b[3]) };
				}
				await Bun.sleep(300);
			}
			throw new Error(`no ${re} on screen`);
		};
		const tap = async (re: RegExp) => {
			const p = await node(re);
			await sh('input', 'tap', String(p.x), String(p.y));
		};
		// Actions show on an expanded notification only: pull it down when they aren't visible.
		const tapAction = async (title: RegExp, action: RegExp) => {
			const visible = await node(action, 1500).catch(() => null);
			if (!visible) {
				const t = await node(title);
				await sh('input', 'swipe', String(t.x), String(t.y), String(t.x), String(t.y + 400), '300');
				await Bun.sleep(500);
			}
			await tap(action);
		};
		const shade = async (open: boolean) => {
			await sh('cmd', 'statusbar', open ? 'expand-notifications' : 'collapse');
			await Bun.sleep(1200);
		};
		const listen = () =>
			app.eval(`(() => { window.__resp = []; window.__off?.(); window.__off = host.on('notificationResponse', (r) => window.__resp.push(r)); return true; })()`);
		const pageResponses = () => app.eval<Response[]>('window.__resp ?? []');

		beforeAll(async () => {
			await sh('pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
			await n('dismissAll');
		});
		afterAll(async () => {
			await shade(false);
			await n('dismissAll').catch(() => {});
		});

		test('show → delivered (payload, subtitle) → replace by id → dismiss', async () => {
			expect(await n('show', { id: 'n1', title: 'Hello', body: 'World', subtitle: '#general', payload: '{"url":"/x"}' })).toMatchObject({ id: 'n1', scheduled: false });
			let list = await until(delivered, (l) => l.some((d) => d.id === 'n1'));
			expect(list.find((d) => d.id === 'n1')).toMatchObject({ id: 'n1', title: 'Hello', body: 'World', subtitle: '#general', payload: '{"url":"/x"}' });
			await n('show', { id: 'n1', title: 'Hello again', renotify: false });
			list = await until(delivered, (l) => l.some((d) => d.title === 'Hello again'));
			expect(list.filter((d) => d.id === 'n1')).toHaveLength(1);
			expect(list.find((d) => d.id === 'n1')?.title).toBe('Hello again');
			await n('dismiss', { id: 'n1' });
			expect((await until(delivered, (l) => !l.some((d) => d.id === 'n1'))).some((d) => d.id === 'n1')).toBe(false);
			await n('show', { id: 'n2', title: 'Legacy' });
			await n('close', { tag: 'n2' }); // legacy alias + key
			expect((await until(delivered, (l) => !l.some((d) => d.id === 'n2'))).some((d) => d.id === 'n2')).toBe(false);
		});

		test('styles, group summary, actions, image from a data: URL', async () => {
			const shownAt = (await deviceNow()) - 60 * 60_000;
			const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
			await n('show', {
				id: 'g1', title: 'Group one', body: 'A body long enough to be shown with the big text style when expanded', group: 'chat', badge: 2, urgency: 'critical', timestamp: shownAt,
				actions: [{ id: 'reply', title: 'Reply', input: { placeholder: 'Message' } }, { id: 'done', label: 'Done', destructive: true, foreground: false }],
			});
			await n('show', { id: 'g2', title: 'Group two', group: 'chat', image: png, icon: png, silent: true });
			const list = await until(delivered, (l) => l.filter((d) => d.group === 'chat').length === 2);
			expect(list.filter((d) => d.group === 'chat').map((d) => d.id).sort()).toEqual(['g1', 'g2']);
			expect(list.some((d) => d.id.startsWith('sd.group:'))).toBe(false); // the summary isn't listed
			expect(list.find((d) => d.id === 'g1')?.date).toBe(shownAt);
			const dump = await sh('dumpsys', 'notification', '--noredact');
			const record = (tag: string) => dump.split('NotificationRecord(').find((r) => r.includes(`pkg=${pkg}`) && r.includes(`tag=${tag} `)) ?? '';
			expect(record('sd.group:chat')).toContain('GROUP_SUMMARY');
			expect(record('g1')).toContain('Notification$BigTextStyle');
			expect(record('g1')).toContain('actions=2');
			expect(record('g1')).toMatch(/"Reply" -> PendingIntent\{[^}]*startActivity/);
			expect(record('g1')).toMatch(/"Done" -> PendingIntent\{[^}]*broadcastIntent/); // foreground: false → no activity
			expect(record('g2')).toContain('Notification$BigPictureStyle');
			// One left in the group → no summary.
			await n('dismiss', { id: 'g2' });
			await Bun.sleep(300);
			expect(await sh('dumpsys', 'notification')).not.toContain('tag=sd.group:chat ');
			await n('dismissAll');
		});

		test('argument errors, setBadge unsupported, setForeground ok', async () => {
			expect(await n('show', { id: 'e' }).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
			expect(await n('show', { id: 'e', title: 'x', channel: 'nope' }).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
			expect(await n('show', { id: 'e', title: 'x', at: Date.now() + 60_000, repeat: 'fortnight' }).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
			expect(await n('setBadge', { count: 3 }).catch((e: unknown) => e)).toMatchObject({ code: 'unsupported' });
			expect(await n('setForeground', { show: true })).toBeNull();
			expect(await n('getPermissionStatus')).toEqual({ status: 'granted' });
		});

		test('channels: config channels created at startup, create / list / delete', async () => {
			type Channel = { id: string; name: string; importance: string; sound: boolean };
			// desktop.config.ts notifications.channels (no implicit "default" channel then)
			const initial = await n<Channel[]>('channels');
			expect(initial.find((c) => c.id === 'messages')).toMatchObject({ name: 'Messages', importance: 'high' });
			expect(initial.find((c) => c.id === 'reminders')).toMatchObject({ name: 'Reminders', importance: 'default' });
			expect(initial.some((c) => c.id === 'default')).toBe(false);
			await n('show', { id: 'c0', title: 'Default channel' });
			expect(await sh('dumpsys', 'notification')).toMatch(/tag=c0 [^\n]*channel=messages/); // the first configured one
			await n('dismiss', { id: 'c0' });
			await n('createChannel', { id: 'e2e', name: 'E2E', description: 'tests', importance: 'high', sound: false, vibrate: false });
			expect((await n<Channel[]>('channels')).find((c) => c.id === 'e2e')).toMatchObject({ name: 'E2E', importance: 'high', sound: false });
			await n('show', { id: 'c1', title: 'On a channel', channel: 'e2e' });
			expect(await sh('dumpsys', 'notification')).toMatch(/tag=c1 [^\n]*channel=e2e/);
			await n('dismiss', { id: 'c1' });
			await n('deleteChannel', { id: 'e2e' });
			expect((await n<Channel[]>('channels')).some((c) => c.id === 'e2e')).toBe(false);
			expect(await n('createChannel', { id: 'x' }).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
		});

		test('Tauri/Electron parity: lines + summary, ongoing, autoCancel, color, visibility', async () => {
			const record = async (tag: string) => (await sh('dumpsys', 'notification', '--noredact')).split('NotificationRecord(').find((r) => r.includes(`pkg=${pkg}`) && r.includes(`tag=${tag} `)) ?? '';
			await n('show', { id: 'p1', title: 'Inbox', body: 'Alice: lunch?\nBob: 12:30', lines: ['Alice: lunch?', 'Bob: 12:30'], summary: '2 new messages', color: '#ff3e00', visibility: 'public', channel: 'reminders' });
			await n('show', { id: 'p2', title: 'Pinned', ongoing: true, visibility: 'secret', closeButtonText: 'Later', toastXml: '<toast/>', channel: 'reminders' });
			await n('show', { id: 'p3', title: 'Sticky', body: 'short', summary: 'from the test', autoCancel: false, channel: 'reminders' });
			await until(delivered, (l) => ['p1', 'p2', 'p3'].every((id) => l.some((d) => d.id === id)));
			const p1 = await record('p1');
			expect(p1).toContain('template=android.app.Notification$InboxStyle');
			expect(p1).toMatch(/android\.textLines=CharSequence\[\] \(2\)\s*\[0\] Alice: lunch\?\s*\[1\] Bob: 12:30/);
			expect(p1).toContain('android.summaryText=String (2 new messages)');
			expect(p1).toContain('color=0xffff3e00');
			expect(p1).toContain('vis=PUBLIC');
			expect(p1).toMatch(/flags=[^ ]*AUTO_CANCEL/);
			const p2 = await record('p2');
			expect(p2).toMatch(/flags=[^ ]*ONGOING_EVENT/);
			expect(p2).not.toMatch(/flags=[^ ]*AUTO_CANCEL/);
			expect(p2).toContain('vis=SECRET');
			const p3 = await record('p3');
			expect(p3).not.toMatch(/flags=[^ ]*AUTO_CANCEL/);
			expect(p3).toContain('template=android.app.Notification$BigTextStyle');
			expect(p3).toContain('android.summaryText=String (from the test)');
			expect(p3).toContain('vis=PRIVATE'); // the default
			expect(await n('show', { id: 'p4', title: 'x', color: 'tomato-ish' }).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_args' });
			await n('dismissAll'); // ongoing ones too
			expect((await until(delivered, (l) => l.length === 0)).length).toBe(0);
		});

		test('schedule: pending → fires on time (notificationShown) → delivered; repeat; dismiss cancels', async () => {
			const at = (await deviceNow()) + 2500;
			const shown = app.nextEvent<{ id: string; payload: string; push: boolean }>('notificationShown', (d) => d.id === 's1', 20_000);
			expect(await n('show', { id: 's1', title: 'Later', body: 'scheduled', at, payload: 'p1' })).toEqual({ id: 's1', tag: 's1', scheduled: true });
			expect(await n('pending')).toEqual([{ id: 's1', title: 'Later', body: 'scheduled', at, payload: 'p1' }]);
			expect(await alarms()).toBe(1);
			expect(await shown).toEqual({ id: 's1', payload: 'p1', push: false });
			expect(await deviceNow()).toBeGreaterThanOrEqual(at);
			expect((await until(delivered, (l) => l.some((d) => d.id === 's1'))).find((d) => d.id === 's1')).toMatchObject({ title: 'Later', payload: 'p1' });
			expect(await n('pending')).toEqual([]);
			// repeat: stays pending, moved to its next occurrence when the start is past
			const past = (await deviceNow()) - 60 * 60_000;
			expect(await n('show', { id: 'r1', title: 'Daily', at: past, repeat: 'day' })).toMatchObject({ scheduled: true });
			const [r1] = await n<{ id: string; at: number; repeat: string }[]>('pending');
			expect(r1).toMatchObject({ id: 'r1', repeat: 'day', at: past + 24 * 60 * 60_000 });
			// same id → replaced, not duplicated
			await n('show', { id: 'r1', title: 'Daily', at: past + 2 * 60 * 60_000, repeat: 'day' });
			expect((await n<unknown[]>('pending')).length).toBe(1);
			await n('dismiss', { id: 'r1' });
			expect(await n('pending')).toEqual([]);
			expect(await alarms()).toBe(0);
			await n('show', { id: 's2', title: 'Later', at: (await deviceNow()) + 60_000 });
			await n('dismissAll');
			expect(await n('pending')).toEqual([]);
			expect(await alarms()).toBe(0);
			expect((await until(delivered, (l) => l.length === 0)).length).toBe(0);
		});

		test.skipIf(!uiAutomator)('tap on the body → notificationResponse (page: target true; server: no target), ring, deep link', async () => {
			await n('dismissAll');
			await listen();
			const server = app.nextEvent<Response>('notificationResponse', (r) => r.id === 'tap1', 20_000);
			await n('show', { id: 'tap1', title: 'Tap me E2E', body: 'body', payload: '{"url":"/about"}' });
			await shade(true);
			await tap(/^Tap me E2E$/);
			const r = await server;
			expect(r).toMatchObject({ id: 'tap1', tag: 'tap1', kind: 'click', actionId: null, input: null, payload: '{"url":"/about"}' });
			expect(r.target).toBeUndefined();
			await app.waitFor(() => (window as any).__resp?.some((x: Response) => x.id === 'tap1'));
			expect((await pageResponses()).find((x) => x.id === 'tap1')).toMatchObject({ id: 'tap1', kind: 'click', target: true, seq: r.seq });
			expect((await n<Response[]>('responses')).find((x) => x.seq === r.seq)).toMatchObject({ id: 'tap1', kind: 'click' });
			expect(await n('claim')).toEqual([]); // delivered live to a loaded page = claimed
			expect((await until(delivered, (l) => !l.some((d) => d.id === 'tap1'))).some((d) => d.id === 'tap1')).toBe(false); // auto-cancel
			await shade(false);
			// host.notifications' default action: the url opens with the SvelteKit router.
			await app.waitFor(() => location.pathname === '/about', { timeout: 10_000 });
			await app.goto('/');
			await app.waitFor('#counter');
		});

		test.skipIf(!uiAutomator)('background action (foreground: false) and inline reply (RemoteInput)', async () => {
			await n('dismissAll');
			await listen();
			const done = app.nextEvent<Response>('notificationResponse', (r) => r.id === 'act1' && r.kind === 'action', 20_000);
			await n('show', { id: 'act1', title: 'Act on me E2E', channel: 'reminders', payload: 'pa', actions: [{ id: 'done', title: 'Mark done', foreground: false }] });
			await shade(true);
			await tapAction(/Act on me E2E/, /^Mark done$/i);
			expect(await done).toMatchObject({ id: 'act1', kind: 'action', actionId: 'done', input: null, payload: 'pa' });
			expect((await until(delivered, (l) => !l.some((d) => d.id === 'act1'))).some((d) => d.id === 'act1')).toBe(false); // consumed
			await shade(false);
			// (Android 15+ keeps a replied-to notification until the user dismisses it: not asserted.)
			const reply = app.nextEvent<Response>('notificationResponse', (r) => r.id === 'rep1', 20_000);
			await n('show', { id: 'rep1', title: 'Reply to me E2E', channel: 'reminders', payload: 'pr', actions: [{ id: 'reply', title: 'Answer', input: { placeholder: 'Your answer', button: 'Send' }, foreground: false }] });
			await shade(true);
			await tapAction(/Reply to me E2E/, /^Answer$/i);
			await node(/Your answer/);
			await sh('input', 'text', 'on%smy%sway');
			await tap(/^Send$/i);
			expect(await reply).toMatchObject({ id: 'rep1', kind: 'reply', actionId: 'reply', input: 'on my way', payload: 'pr' });
			await app.waitFor(() => (window as any).__resp?.some((x: Response) => x.id === 'rep1' && x.target === true));
			await shade(false);
		});

		test.skipIf(!uiAutomator)('swipe away → kind "dismiss" (deleteIntent)', async () => {
			await n('dismissAll');
			const gone = app.nextEvent<Response>('notificationResponse', (r) => r.id === 'sw1', 20_000);
			await n('show', { id: 'sw1', title: 'Swipe me E2E', channel: 'reminders', payload: 'ps' });
			await shade(true);
			const p = await node(/^Swipe me E2E$/);
			await sh('input', 'swipe', String(p.x1), String(p.y), String(p.x2 + 400), String(p.y), '250');
			expect(await gone).toMatchObject({ id: 'sw1', kind: 'dismiss', actionId: null, payload: 'ps' });
			await shade(false);
		});

		test.skipIf(!uiAutomator)('autoCancel: false and ongoing: a click / an action report but keep the notification', async () => {
			await n('dismissAll');
			const click = app.nextEvent<Response>('notificationResponse', (r) => r.id === 'keep1', 20_000);
			await n('show', { id: 'keep1', title: 'Keep me E2E', channel: 'reminders', autoCancel: false, payload: 'pk' });
			await shade(true);
			await tap(/^Keep me E2E$/);
			expect(await click).toMatchObject({ id: 'keep1', kind: 'click', payload: 'pk' });
			await Bun.sleep(800);
			expect((await delivered()).some((d) => d.id === 'keep1')).toBe(true);
			await n('dismiss', { id: 'keep1' });
			await shade(false);
			const act = app.nextEvent<Response>('notificationResponse', (r) => r.id === 'on1', 20_000);
			await n('show', { id: 'on1', title: 'Ongoing E2E', channel: 'reminders', ongoing: true, actions: [{ id: 'pause', title: 'Pause it', foreground: false }] });
			await shade(true);
			await tapAction(/^Ongoing E2E$/, /^Pause it$/i);
			expect(await act).toMatchObject({ id: 'on1', kind: 'action', actionId: 'pause' });
			await Bun.sleep(800);
			expect((await delivered()).some((d) => d.id === 'on1')).toBe(true);
			await n('dismiss', { id: 'on1' });
			await shade(false);
		});

		test('FCM-displayed tap (launcher intent with sd / sd_id); claim when no page is loaded; forged intents ignored', async () => {
			await listen();
			const start = (...extras: string[]) => sh('am', 'start', '-n', `${pkg}/dev.sveltedesktop.MainActivity`, ...extras);
			// live: the page is loaded
			const live = app.nextEvent<Response>('notificationResponse', (r) => r.id === 'push-live', 20_000);
			// (no url: a url would navigate the page — the default action — and drop window.__resp)
			await start('--es', 'google.message_id', '0:live', '--es', 'sd', '{"data":{"chat":1}}', '--es', 'sd_id', 'push-live');
			expect(await live).toMatchObject({ id: 'push-live', kind: 'click', payload: '{"data":{"chat":1}}' });
			await app.waitFor(() => (window as any).__resp?.some((x: Response) => x.id === 'push-live' && x.target === true));
			// no page (a document without the bridge: an image): it waits in the claim queue, the server still sees it
			const origin = await app.eval<string>('location.origin');
			await app.eval("setTimeout(() => { location.href = '/robots.txt'; }, 300); null"); // after this eval's reply
			await Bun.sleep(1500); // an eval sent mid-navigation polls the next document and stalls: let it land
			expect(await until(() => app.eval<string>('location.pathname').catch(() => ''), (h) => h === '/robots.txt', 20_000)).toBe('/robots.txt');
			const queued = app.nextEvent<Response>('notificationResponse', (r) => r.id === 'push-cold', 20_000);
			await start('--es', 'google.message_id', '0:cold', '--es', 'sd', '{"url":"/claimed"}', '--es', 'sd_id', 'push-cold');
			const q = await queued;
			const claimed = await n<Response[]>('claim');
			expect(claimed).toHaveLength(1);
			expect(claimed[0]).toMatchObject({ id: 'push-cold', kind: 'click', payload: '{"url":"/claimed"}', seq: q.seq });
			expect(await n('claim')).toEqual([]); // once
			const ring = await n<Response[]>('responses');
			expect(ring.map((r) => r.id)).toEqual(expect.arrayContaining(['push-live', 'push-cold']));
			expect(ring.length).toBeLessThanOrEqual(64);
			// our extras without the per-install nonce: dropped
			await start('--es', 'dev.sveltedesktop.notification.id', 'forged', '--es', 'dev.sveltedesktop.notification.kind', 'click');
			await Bun.sleep(1500);
			expect((await n<Response[]>('responses')).some((r) => r.id === 'forged')).toBe(false);
			expect(await n('claim')).toEqual([]);
			await app.eval(`setTimeout(() => { location.href = ${JSON.stringify(`${origin}/`)}; }, 300); null`);
			await Bun.sleep(1500);
			await app.waitFor('#counter', { timeout: 20_000 });
		});

		test('push without FCM in the build and no UnifiedPush distributor: register → unavailable, token null, unregister ok', async () => {
			// With a distributor installed (ntfy, the UnifiedPush tests) register would use it instead.
			const distributor = !(await sh('cmd', 'package', 'query-receivers', '--brief', '-a', 'org.unifiedpush.android.distributor.REGISTER')).includes('No receivers');
			await app.platform('push', 'unregister');
			if (!distributor) {
				const e = (await app.platform('push', 'register').catch((x: unknown) => x)) as { code: string; message: string };
				expect(e).toMatchObject({ code: 'unavailable' });
				expect(e.message).toContain('push.fcm.googleServices');
				expect(e.message).toContain('UnifiedPush');
			}
			expect(await app.platform('push', 'token')).toBeNull();
			expect(await app.platform('push', 'unregister')).toBeNull();
		});

		test('a schedule survives a force-stop: re-armed and missed ones delivered at start', async () => {
			const at = (await deviceNow()) + 1500;
			await n('show', { id: 'boot1', title: 'After restart', at, payload: 'pb' });
			await n('show', { id: 'boot2', title: 'Tomorrow', at: at + 24 * 60 * 60_000 });
			await app.close(); // am force-stop: the process and its alarms are gone
			await Bun.sleep(2500);
			app = await launch({ android: { serial: process.env.ANDROID_SERIAL, install: false }, timeout: 60_000 });
			await app.waitFor('#counter', { timeout: 20_000 });
			expect((await until(delivered, (l) => l.some((d) => d.id === 'boot1'))).find((d) => d.id === 'boot1')).toMatchObject({ title: 'After restart', payload: 'pb' });
			expect((await n<{ id: string }[]>('pending')).map((p) => p.id)).toEqual(['boot2']);
			expect(await alarms()).toBe(1); // boot2 re-armed
			await n('dismissAll');
		});
	});

	test('screenshot', async () => {
		const png = await app.screenshot();
		expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
	});
});

// The same app built with push.fcm (a fake google-services.json: the build is real, the
// Firebase project isn't). Builds .desktop/dist-fcm from the staged Android server, so run
// it after `bun run build:android`: ANDROID_E2E=1 ANDROID_FCM_E2E=1 bun run test:android
describe.skipIf(!process.env.ANDROID_E2E || !process.env.ANDROID_FCM_E2E)('android + FCM', () => {
	const adb = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
	const serial = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
	const root = new URL('..', import.meta.url).pathname;
	let app: AppHandle;
	let apk: string;
	beforeAll(async () => {
		const { loadConfig } = await import('@svelte-desktop/shell/config');
		// not a package export: the build step itself, by path
		const { packageAndroid } = await import(`${root}node_modules/@svelte-desktop/shell/src/build/package-android.ts`);
		const c = await loadConfig(root);
		c.push = { ...c.push, fcm: { googleServices: 'tests/fixtures/google-services.fake.json' } };
		c.build = { ...c.build, target: 'android', outDir: '.desktop/dist-fcm' };
		apk = (await packageAndroid(c, `${root}.desktop/stage`)).app;
		await Bun.$`rm -rf ${`${root}.desktop/work/android`}`.quiet();
		await Bun.$`${adb} ${serial} logcat -c`.quiet().nothrow();
		app = await launch({ android: { apk, serial: process.env.ANDROID_SERIAL }, timeout: 60_000 });
		await app.waitFor('#counter', { timeout: 20_000 });
	}, 300_000);
	afterAll(() => app?.close());

	test('Firebase is in the APK: merged components, FirebaseApp initialised from google-services.json', async () => {
		const pkg = await Bun.$`${adb} ${serial} shell dumpsys package dev.svelte_desktop.notes`.quiet().text();
		expect(pkg).toContain('dev.svelte_desktop.notes/dev.sveltedesktop.PushService');
		expect(pkg).toContain('com.google.firebase.iid.FirebaseInstanceIdReceiver');
		expect(pkg).toContain('com.google.firebase.provider.FirebaseInitProvider');
		const log = await Bun.$`${adb} ${serial} logcat -d -s ${['FirebaseApp:*', 'FirebaseInitProvider:*']}`.quiet().nothrow().text();
		expect(log).toContain('FirebaseApp initialization successful');
		expect(log).not.toContain('FirebaseApp initialization unsuccessful');
	});

	test('push.register with a fake project fails cleanly (unavailable), the app keeps running', async () => {
		await Bun.$`${adb} ${serial} shell pm grant dev.svelte_desktop.notes android.permission.POST_NOTIFICATIONS`.quiet().nothrow();
		const r = await app.platform<{ provider: string; token: string }>('push', 'register').catch((e: { code: string; message: string }) => e);
		console.log('  push.register →', JSON.stringify(r), (r as { message?: string }).message ?? '');
		if ('token' in r) expect(r).toMatchObject({ provider: 'fcm' }); // a real google-services.json
		else {
			expect(r).toMatchObject({ code: 'unavailable' });
			expect((r as unknown as { message: string }).message).toMatch(/^push\.register: no FCM token \(.+\)$/);
			expect(await app.platform('push', 'token')).toBeNull();
		}
		expect(await app.platform<string>('app', 'getName')).toBe('Svelte Notes');
		expect(await app.platform('push', 'unregister').catch((e: { code: string }) => e.code)).toBeDefined();
		expect(await app.platform('notifications', 'show', { id: 'fcm-local', title: 'Local still works' })).toMatchObject({ id: 'fcm-local' });
		await app.platform('notifications', 'dismissAll');
	}, 120_000);
});

// A real reboot (opt-in, slow: ~2–4 min): schedules are re-armed by NotificationReceiver on
// BOOT_COMPLETED without the app being opened. ANDROID_E2E=1 ANDROID_REBOOT_E2E=1 bun run test:android
describe.skipIf(!process.env.ANDROID_E2E || !process.env.ANDROID_REBOOT_E2E)('android reboot', () => {
	const adb = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
	const serial = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
	const pkg = 'dev.svelte_desktop.notes';
	const sh = (...args: string[]) => Bun.$`${adb} ${serial} shell ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`.quiet().nothrow().text();
	const posted = async () =>
		(await sh('dumpsys', 'notification')).split('\n').flatMap((l) => (l.includes(`pkg=${pkg} `) ? [/ tag=(\S+) /.exec(l)?.[1] ?? ''] : []));
	const alarms = async () => (await sh('dumpsys', 'alarm')).split('\n').filter((l) => /^\s*tag=\*walarm\*:dev\.sveltedesktop\.NOTIFICATION_ALARM/.test(l)).length;
	const waitFor = async (what: string, ok: () => Promise<boolean>, ms: number) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (await ok().catch(() => false)) return;
			await Bun.sleep(2000);
		}
		throw new Error(`timed out waiting for ${what}`);
	};

	test('a reboot: missed schedules posted and the rest re-armed at BOOT_COMPLETED, app never opened', async () => {
		let app = await launch({ android: { serial: process.env.ANDROID_SERIAL }, timeout: 60_000 });
		await app.waitFor('#counter', { timeout: 20_000 });
		await sh('pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
		const n = <T = unknown>(op: string, args: Record<string, unknown> = {}) => app.platform<T>('notifications', op, args);
		await n('dismissAll');
		// PackageManager persists a fresh install's state (launched once → not "stopped"; the
		// POST_NOTIFICATIONS grant) ~10 s after a change: reboot sooner and the app gets no boot
		// broadcast and loses the permission. So settle first, then schedule (written synchronously).
		await Bun.sleep(15_000);
		const now = await app.eval<number>('Date.now()');
		const soon = now + 12_000; // passes while the device reboots: delivered at boot
		const later = now + 90_000; // still ahead at boot: re-armed, delivered by the alarm
		const day = now + 24 * 60 * 60_000; // stays pending
		await n('show', { id: 'boot-missed', title: 'Missed during reboot', at: soon, payload: 'pm', channel: 'reminders' });
		await n('show', { id: 'boot-hourly', title: 'Every hour', at: soon, repeat: 'hour', channel: 'reminders' });
		await n('show', { id: 'boot-later', title: 'Due after boot', at: later, channel: 'reminders' });
		await n('show', { id: 'boot-tomorrow', title: 'Tomorrow', at: day, channel: 'reminders' });
		expect((await n<{ id: string }[]>('pending')).length).toBe(4);
		// Not app.close(): a force-stopped app gets no BOOT_COMPLETED. Just leave it in the background.
		await sh('input', 'keyevent', 'KEYCODE_HOME');
		// The first handle can't be closed (that force-stops the app): drop its port forward by hand.
		await Bun.$`${adb} ${serial} forward --remove-all`.quiet().nothrow();
		const bootId = (await sh('cat', '/proc/sys/kernel/random/boot_id')).trim();
		expect((await Bun.$`${adb} ${serial} reboot`.quiet().nothrow()).exitCode).toBe(0);
		await waitFor('the device to come back', async () => {
			const id = (await sh('cat', '/proc/sys/kernel/random/boot_id')).trim();
			return !!id && id !== bootId && (await sh('getprop', 'sys.boot_completed')).trim() === '1';
		}, 300_000);
		// (The device clock is briefly unreliable right after boot: no time assertion here.)
		// BOOT_COMPLETED → NotificationReceiver: missed ones posted, the others re-armed. The app's UI never ran.
		expect(await posted()).not.toContain('boot-later');
		await waitFor('the missed notifications', async () => ['boot-missed', 'boot-hourly'].every((t) => posted().then((p) => p.includes(t))), 120_000);
		expect(await sh('dumpsys', 'activity', 'activities')).not.toMatch(/ActivityRecord\{[^}]*dev\.svelte_desktop\.notes\//); // no activity since boot
		// boot-later (unless already fired), boot-hourly's next hour, boot-tomorrow (dumpsys alarm can come back empty right after boot)
		await waitFor('re-armed alarms', async () => (await alarms()) >= 2, 60_000);
		await waitFor('boot-later, from its re-armed alarm', async () => (await posted()).includes('boot-later'), 240_000);
		expect(await posted()).not.toContain('boot-tomorrow');
		expect(await sh('dumpsys', 'notification', '--noredact')).toContain('sd.payload=String (pm)'); // the stored spec, verbatim
		// Now open the app (launch() force-stops it first, which also clears its notifications): pending survives.
		app = await launch({ android: { serial: process.env.ANDROID_SERIAL, install: false }, timeout: 90_000 });
		await app.waitFor('#counter', { timeout: 30_000 });
		const pending = await n<{ id: string; at: number; repeat?: string }[]>('pending');
		expect(pending.map((p) => p.id).sort()).toEqual(['boot-hourly', 'boot-tomorrow']);
		expect(pending.find((p) => p.id === 'boot-hourly')).toMatchObject({ repeat: 'hour', at: soon + 60 * 60_000 });
		await n('dismissAll');
		await app.close();
	}, 900_000);
});

// Self-hosted push through UnifiedPush, for real: the ntfy app (F-Droid build, pinned sha256) as the
// distributor on the public ntfy.sh server; the test sends with createPush({ webpush }) like a server
// would (VAPID + RFC 8291). Needs network. ANDROID_E2E=1 ANDROID_UP_E2E=1 bun run test:android
describe.skipIf(!process.env.ANDROID_E2E || !process.env.ANDROID_UP_E2E)('android + UnifiedPush (ntfy)', () => {
	const adb = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
	const serial = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
	const pkg = 'dev.svelte_desktop.notes';
	const NTFY = { version: 63, sha256: 'b4baa6f668bd57ad5df3b4e0e769165dcf25c5ee19fdb04f78077ee819616f2a' }; // io.heckel.ntfy 1.25.2
	const sh = (...args: string[]) => Bun.$`${adb} ${serial} shell ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`.quiet().nothrow().text();
	type Target = { provider: 'webpush'; endpoint: string; keys: { p256dh: string; auth: string } };
	let app: AppHandle;
	let target: Target;
	let push: import('@svelte-desktop/shell/push').PushSender;
	const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> => {
		const end = Date.now() + ms;
		let v = await get();
		while (!ok(v) && Date.now() < end) {
			await Bun.sleep(250);
			v = await get();
		}
		return v;
	};
	const delivered = () => app.platform<{ id: string; title: string; body: string; payload?: string }[]>('notifications', 'delivered');
	// ntfy keeps its connection in a foreground service, which Android 14+ won't start from the background:
	// opening ntfy once starts it (a real user has it running).
	const wakeNtfy = async () => {
		await sh('monkey', '-p', 'io.heckel.ntfy', '-c', 'android.intent.category.LAUNCHER', '1');
		await Bun.sleep(5000);
		await sh('am', 'start', '-n', `${pkg}/dev.sveltedesktop.MainActivity`);
		await Bun.sleep(1500);
	};

	beforeAll(async () => {
		if ((await sh('cmd', 'package', 'query-receivers', '--brief', '-a', 'org.unifiedpush.android.distributor.REGISTER')).includes('No receivers')) {
			const apk = `${process.env.HOME}/.cache/svelte-desktop/ntfy-${NTFY.version}.apk`;
			const ok = async () => (await Bun.file(apk).exists()) && new Bun.CryptoHasher('sha256').update(await Bun.file(apk).arrayBuffer()).digest('hex') === NTFY.sha256;
			if (!(await ok())) await Bun.write(apk, await fetch(`https://f-droid.org/repo/io.heckel.ntfy_${NTFY.version}.apk`));
			if (!(await ok())) throw new Error('ntfy APK: sha256 mismatch');
			await Bun.$`${adb} ${serial} install -r ${apk}`.quiet();
		}
		await sh('pm', 'grant', 'io.heckel.ntfy', 'android.permission.POST_NOTIFICATIONS');
		app = await launch({ android: { serial: process.env.ANDROID_SERIAL }, timeout: 60_000 });
		await app.waitFor('#counter', { timeout: 20_000 });
		await sh('pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
		await app.platform('notifications', 'dismissAll');
		const { createPush, generateVapidKeys } = await import('@svelte-desktop/shell/push');
		const vapid = await generateVapidKeys();
		push = createPush({ webpush: { ...vapid, subject: 'mailto:e2e@svelte-desktop.dev' } });
		await wakeNtfy(); // opened once, as a user would after installing it
		await app.platform('push', 'unregister'); // a fresh registration → a new endpoint → pushToken
		const token = app.nextEvent<Target>('pushToken', (t) => t.provider === 'webpush', 40_000);
		target = await app.platform<Target>('push', 'register', { vapidPublicKey: vapid.publicKey });
		expect(await token).toEqual(target);
		await wakeNtfy();
		await app.eval(`(() => { window.__push = []; host.on('pushMessage', (m) => window.__push.push(m)); return true; })()`);
	}, 180_000);
	afterAll(async () => {
		await app?.platform('push', 'unregister').catch(() => {});
		await app?.platform('notifications', 'dismissAll').catch(() => {});
		await app?.close();
	});

	test('register → a Web Push target from the distributor (P-256 key + auth secret), push.token', async () => {
		expect(target.provider).toBe('webpush');
		expect(target.endpoint).toMatch(/^https:\/\/ntfy\.sh\/up[A-Za-z0-9]+\?up=1$/);
		expect(Buffer.from(target.keys.p256dh, 'base64url')).toHaveLength(65);
		expect(Buffer.from(target.keys.p256dh, 'base64url')[0]).toBe(4); // uncompressed point
		expect(Buffer.from(target.keys.auth, 'base64url')).toHaveLength(16);
		expect(await app.platform('push', 'token')).toEqual(target);
		expect(await sh('dumpsys', 'package', pkg)).toContain('dev.sveltedesktop.UnifiedPushReceiver');
	});

	test('createPush → ntfy.sh → ntfy → decrypted, shown with its id, pushMessage in the page; same id replaces', async () => {
		const first = app.nextEvent<{ id: string; payload: string; notification?: { title: string } }>('pushMessage', (m) => m.id === 'up-1', 30_000);
		await push.send(target, { id: 'up-1', title: 'From ntfy E2E', body: 'via UnifiedPush', url: '/about', data: { n: 1 } });
		const m = await first;
		expect(m).toMatchObject({ id: 'up-1', foreground: true, notification: { title: 'From ntfy E2E', body: 'via UnifiedPush' } });
		expect(JSON.parse(m.payload)).toMatchObject({ url: '/about', data: { n: 1 } });
		let list = await until(delivered, (l) => l.some((d) => d.id === 'up-1'));
		expect(list.find((d) => d.id === 'up-1')).toMatchObject({ title: 'From ntfy E2E', body: 'via UnifiedPush' });
		await app.waitFor(() => (window as any).__push?.some((x: { id: string }) => x.id === 'up-1'));
		const second = app.nextEvent('pushMessage', (x: { notification?: { title: string } }) => x.notification?.title === 'Replaced E2E', 30_000);
		await push.send(target, { id: 'up-1', title: 'Replaced E2E', body: 'second', url: '/about' });
		await second;
		list = await until(delivered, (l) => l.some((d) => d.title === 'Replaced E2E'));
		expect(list.filter((d) => d.id === 'up-1')).toHaveLength(1);
	}, 90_000);

	test('a tap on the pushed notification is a notificationResponse with its payload and navigates', async () => {
		await app.goto('/');
		const resp = app.nextEvent<{ id: string; kind: string; payload: string }>('notificationResponse', (r) => r.id === 'up-1', 30_000);
		await sh('cmd', 'statusbar', 'expand-notifications');
		await Bun.sleep(1200);
		await sh('uiautomator', 'dump', '/sdcard/sd-ui.xml');
		const xml = await sh('cat', '/sdcard/sd-ui.xml');
		const node = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0]).find((n) => /text="Replaced E2E"/.test(n));
		const b = node && /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
		if (!b) throw new Error('the pushed notification is not in the shade (uiautomator busy?)');
		await sh('input', 'tap', String((Number(b[1]) + Number(b[3])) >> 1), String((Number(b[2]) + Number(b[4])) >> 1));
		const r = await resp;
		expect(r).toMatchObject({ id: 'up-1', kind: 'click' });
		expect(JSON.parse(r.payload).url).toBe('/about');
		expect(await until(() => app.eval<string>('location.pathname'), (p) => p === '/about')).toBe('/about');
		await app.goto('/');
	}, 90_000);

	test('a background push (no title): pushMessage only, no notification', async () => {
		const msg = app.nextEvent<{ id: string; payload: string; notification?: unknown }>('pushMessage', (m) => m.id === 'up-bg', 30_000);
		await push.send(target, { id: 'up-bg', background: true, data: { sync: true } });
		const m = await msg;
		expect(m.notification).toBeUndefined();
		expect(JSON.parse(m.payload)).toMatchObject({ data: { sync: true } });
		await Bun.sleep(1000);
		expect((await delivered()).some((d) => d.id === 'up-bg')).toBe(false);
	}, 60_000);

	test('the app not running: ntfy wakes the receiver, which decrypts and shows it', async () => {
		await sh('input', 'keyevent', 'KEYCODE_HOME');
		await Bun.sleep(1000);
		// Kill the process without force-stop (that would mark the app stopped: no broadcasts at all).
		// The debug build allows run-as; `am kill` alone leaves a recently used process alive.
		const pid = (await sh('pidof', pkg)).trim();
		if (pid) await sh('run-as', pkg, 'kill', '-9', pid);
		await sh('am', 'kill', pkg);
		await Bun.sleep(1500);
		expect((await sh('pidof', pkg)).trim()).toBe('');
		await push.send(target, { id: 'up-cold', title: 'While closed E2E', body: 'cold', url: '/about' });
		const posted = async () => (await sh('dumpsys', 'notification')).includes('tag=up-cold ');
		const end = Date.now() + 30_000;
		while (!(await posted()) && Date.now() < end) await Bun.sleep(500);
		expect(await posted()).toBe(true);
		const woken = (await sh('pidof', pkg)).trim();
		expect(woken).not.toBe('');
		expect(woken).not.toBe(pid); // a new process, started for the broadcast
		// back to a running app for afterAll
		app = await launch({ android: { serial: process.env.ANDROID_SERIAL, install: false }, timeout: 60_000 });
		await app.waitFor('#counter', { timeout: 20_000 });
		await app.platform('push', 'unregister');
		expect(await app.platform('push', 'token')).toBeNull();
	}, 120_000);
});
