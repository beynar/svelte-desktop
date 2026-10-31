// Drives the built app (`bunx --bun vite build` first) in its real window.
// `bun run test` / `bun run test:dev` (same tests against `vite dev`). App startup needs
// more than bun's default 5 s per hook, hence `--timeout` in the scripts.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

let app: AppHandle;
beforeAll(async () => {
	app = await launch(process.env.DESKTOP_TEST_DEV ? { dev: true } : {});
	await app.waitFor('#counter');
});
afterAll(() => app?.close());

test('SSR + hydration + remote command', async () => {
	const before = Number(await app.text('#counter'));
	await app.click('button:not([type=button])');
	await app.waitFor((n: number) => Number(document.querySelector('#counter')?.textContent) === n, { timeout: 5000 }).catch(() => {});
	const clicked = await app.eval<number>(`Number(document.querySelector('#counter').textContent)`);
	expect(clicked).toBeGreaterThanOrEqual(before);
});

test('remote form adds a note', async () => {
	const note = `test note ${Date.now()}`;
	await app.fill('input[name^=text]', note);
	await app.press('input[name^=text]', 'Enter');
	await app.waitFor(`li`);
	await app.waitFor(new Function(`return document.body.innerText.includes(${JSON.stringify(note)})`) as () => boolean);
	expect(await app.text('ul')).toContain(note);
});

test('platform API: window bounds and title', async () => {
	await app.platform('window', 'setTitle', { title: 'Under test' });
	expect(await app.platform<string>('window', 'getTitle')).toBe('Under test');
	const b = await app.platform<{ bounds: { width: number } }>('window', 'getBounds');
	expect(b.bounds.width).toBeGreaterThan(400);
});

test('native Swift plugin', async () => {
	expect(await app.platform<string>('greeter', 'hello', { name: 'test' })).toContain('from Swift');
	expect(await app.platform<number>('greeter', 'add', { a: 1, b: 2 })).toBe(3);
	const pong = app.nextEvent('greeter.pong');
	await app.platform('greeter', 'ping');
	expect(await pong).toHaveProperty('at');
});

test('menu-bar popover: pre-warmed route, transparent, sized to content, opened by the tray', async () => {
	let quick: { id: string; ready: boolean; height: number } | undefined;
	for (let i = 0; i < 80 && !quick?.ready; i++) {
		quick = (await app.platform<Array<typeof quick & {}>>('popover', 'list')).find((p) => p.id === 'status-item');
		await Bun.sleep(50);
	}
	expect(quick?.ready).toBe(true);
	const inside = await app.platform<{ text: string; bg: string; height: number; id: string }>('webview', 'executeJavaScript', {
		popoverId: 'status-item',
		code: `({ text: document.body.innerText, bg: getComputedStyle(document.body).backgroundColor,
		          height: Math.ceil(document.querySelector('.shell-popover-content').getBoundingClientRect().height), id: window.__shellPopover.id })`
	});
	expect(inside.text).toContain('Quick note');
	expect(inside.bg).toBe('rgba(0, 0, 0, 0)');
	expect(inside.id).toBe('status-item');
	const info = await app.platform<{ height: number }>('popover', 'get', { id: 'status-item' });
	expect(Math.abs(info.height - inside.height)).toBeLessThanOrEqual(2);
	await Bun.sleep(600); // a new status item settles in the menu bar asynchronously
	const shown = app.nextEvent('popoverShown', (e: { id: string }) => e.id === 'status-item');
	await app.platform('tray', 'performClick');
	expect((await shown).id).toBe('status-item');
	await app.platform('popover', 'hide', { id: 'status-item' });
});

test('desktop events reach the page (onDesktopEvent)', async () => {
	await app.platform('events', 'emit', { channel: 'desktop', data: { type: 'test-ping', data: 1 } });
	await app.waitFor(() => [...document.querySelectorAll('.log li')].some((li) => li.textContent!.includes('test-ping')));
});

test('client-side navigation + platform stores', async () => {
	await app.goto('/platform');
	await app.waitFor(() => /darwin/.test(document.querySelector('[data-testid=identity]')?.textContent ?? ''));
	expect(await app.text('[data-testid=native-page]')).toContain('from Swift');
	await app.waitFor('[data-testid=addon]');
	expect(await app.text('[data-testid=addon]')).toContain('fib(30) = 832040');
	await app.goto('/');
});

test('screenshot', async () => {
	const png = await app.screenshot();
	expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
});

test('hidden title bar: the page gets its chrome metrics, and the style switches at runtime', async () => {
	const chrome = () =>
		app.eval<{ bar: number; controls: number; mode: string }>(`(() => { const s = getComputedStyle(document.documentElement);
			return { bar: parseFloat(s.getPropertyValue('--desktop-titlebar-height')), controls: parseFloat(s.getPropertyValue('--desktop-controls-width')),
				mode: document.documentElement.dataset.desktopTitlebar }; })()`);
	const inset = await chrome(); // desktop.config: titleBarStyle 'hiddenInset'
	expect(inset.mode).toBe('hiddenInset');
	expect(inset.bar).toBeGreaterThan(20);
	expect(inset.controls).toBeGreaterThan(60);
	expect(await app.eval<number>(`document.querySelector('nav').getBoundingClientRect().top`)).toBe(0); // content under the title bar
	await app.platform('window', 'setTitleBarStyle', { style: 'default' });
	expect(await chrome()).toMatchObject({ bar: 0, controls: 0, mode: 'default' });
	await app.platform('window', 'setTitleBarStyle', { style: 'hiddenInset' });
	expect((await chrome()).bar).toBe(inset.bar);
	expect((await app.platform('window', 'setTitleBarStyle', { style: 'bogus' }).catch((e: unknown) => e)) as object).toMatchObject({ code: 'invalid_args' });
});

test('menu-bar popover: adding a quick note works and the list updates', async () => {
	const inPopover = <T>(code: string) => app.platform<T>('webview', 'executeJavaScript', { popoverId: 'status-item', code });
	const note = `popover note ${Date.now()}`;
	await inPopover(`(() => { const i = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(note)});
		i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit(); })()`);
	const end = Date.now() + 5000;
	let text = '';
	while (Date.now() < end && !(text = await inPopover<string>('document.body.innerText')).includes(note)) await Bun.sleep(100);
	expect(text).toContain(note);
	expect(text).not.toContain('Internal Error');
	expect(await inPopover<string>(`document.querySelector('input').value`)).toBe(''); // form reset
});

test('background jobs: own process, progress, events, result, cancel, failure, concurrency, page store', async () => {
	const api = <T>(path: string, init?: RequestInit) => app.eval<T>(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then((r) => r.json())`);
	const start = (body: unknown) => api<{ id: string; state: string }>('/api/jobs', { method: 'POST', body: JSON.stringify(body) });

	const halfway = app.nextEvent<{ channel: string; data: { event?: { data: { halfway: number } } } }>('message', (m) => m.channel === 'jobs' && !!m.data?.event);
	const doneEvent = app.nextEvent<{ channel: string; data: { change?: { type: string; job: { name: string } } } }>('message', (m) => m.channel === 'jobs' && m.data?.change?.type === 'done');
	const a = await start({ name: 'count', args: { to: 6, delay: 30 } });
	const done = await api<{ state: string; result: { counted: number; pid: number }; progress: number; log: string[] }>(`/api/jobs?id=${a.id}&wait=1`);
	expect(done).toMatchObject({ state: 'done', progress: 1, result: { counted: 6 } });
	const { pid } = await app.platform<{ pid: number }>('diagnostics', 'info');
	expect(done.result.pid).not.toBe(pid); // its own process
	expect(done.log.join('\n')).toContain('counted to 6');
	expect((await halfway).data.event!.data).toEqual({ halfway: 3 });
	expect((await doneEvent).data.change!.job.name).toBe('count');

	const f = await start({ name: 'fail' });
	expect(await api(`/api/jobs?id=${f.id}&wait=1`)).toMatchObject({ state: 'failed', error: 'this job always fails' });
	expect(await api(`/api/jobs?id=${(await start({ name: 'nope' })).id}&wait=1`)).toMatchObject({ state: 'failed' });

	const slow = await start({ name: 'count', args: { to: 100, delay: 50 } });
	await Bun.sleep(400);
	expect(await api(`/api/jobs?id=${slow.id}`, { method: 'DELETE' })).toEqual({ canceled: true });
	expect(await api(`/api/jobs?id=${slow.id}&wait=1`)).toMatchObject({ state: 'canceled' });

	// concurrency 1: the second waits for the first
	const c1 = await start({ name: 'count', args: { to: 5, delay: 40 }, concurrency: 1 });
	const c2 = await start({ name: 'count', args: { to: 5, delay: 40 }, concurrency: 1 });
	expect(c2.state).toBe('queued');
	const [r1, r2] = await Promise.all([api<any>(`/api/jobs?id=${c1.id}&wait=1`), api<any>(`/api/jobs?id=${c2.id}&wait=1`)]);
	expect(r2.startedAt).toBeGreaterThanOrEqual(r1.endedAt);

	// the page store mirrors the server
	await app.goto('/');
	await app.waitFor(() => /\d+ done/.test(document.querySelector('#jobs-done')?.textContent ?? ''));
	expect(Number((await app.text('#jobs-done')).split(' ')[0])).toBeGreaterThanOrEqual(3);
}, 60_000);

test('the `host` global, without imports, in the page and in server code', async () => {
	const page = await app.eval<Record<string, unknown>>(`(async () => ({
		available: host.available, name: host.app.name, dark: typeof host.theme.dark,
		clipboard: (await host.clipboard.writeText('via host'), await host.clipboard.readText()),
		jobs: Array.isArray(host.jobs.list()), start: typeof host.jobs.start, info: (await host.app.getInfo()).name }))()`);
	expect(page).toEqual({ available: true, name: 'Svelte Notes', dark: 'boolean', clipboard: 'via host', jobs: true, start: 'undefined', info: 'Svelte Notes' });
	const server = await app.eval<Record<string, unknown>>(`fetch('/api/host').then((r) => r.json())`);
	expect(server).toMatchObject({ available: true, name: 'Svelte Notes', jobs: true, start: 'function' });
	expect(String(server.data)).toContain('dev.svelte-desktop.notes');
});

test('permissions: declared in desktop.config, reactive statuses, undeclared error, the guided panel', async () => {
	const declared = await app.eval<Record<string, string>>('host.permissions.declared()');
	expect(declared).toEqual({ camera: 'Notes can attach photos from your camera.', screenRecording: 'Notes can attach a screenshot of your screen.' });
	await app.waitFor(() => ['granted', 'denied', 'notDetermined'].includes(document.querySelector('[data-permission=camera]')?.textContent ?? ''));
	expect(['granted', 'denied', 'notDetermined']).toContain(await app.eval<string>('host.permissions.camera'));
	const undeclared = await app.eval<{ code: string; message: string }>(`host.permissions.request('microphone').then(() => null, (e) => ({ code: e.code, message: e.message }))`);
	expect(undeclared.code).toBe('undeclared');
	expect(undeclared.message).toContain("permissions: { microphone:");
	// The guided flow (without opening System Settings here): the panel opens with the draggable icon…
	const screen = await app.eval<string>(`host.permissions.status('screenRecording')`);
	if (screen === 'granted') return; // nothing to guide on a machine that already granted it
	await app.eval(`(window.__guide = host.permissions.guide('screenRecording', { open: false }), true)`);
	await app.waitFor(() => true);
	let state: { open: boolean; name?: string; draggable?: boolean } = { open: false };
	for (let i = 0; i < 40 && !state.open; i++) {
		state = await app.platform('permissions', 'guideState');
		await Bun.sleep(50);
	}
	expect(state).toMatchObject({ open: true, name: 'screenRecording', draggable: true });
	// …and "Not now" resolves the guide with canceled: true.
	await app.platform('permissions', 'cancelGuide');
	expect(await app.eval('window.__guide')).toMatchObject({ canceled: true, status: 'denied' });
	expect((await app.platform<{ open: boolean }>('permissions', 'guideState')).open).toBe(false);
});

test('notifications: dedupe by id, schedule, lists, deep link on click, actions/reply, cold-start claim', async () => {
	const first = await app.eval<{ id?: string; code?: string }>(`host.notifications.show({ id: 'e2e-1', title: 'E2E', body: 'one', url: '/about', data: { n: 1 } }).then((r) => r, (e) => ({ code: e.code }))`);
	if (process.env.DESKTOP_TEST_DEV) {
		// `vite dev` runs the shell unbundled: macOS only notifies from a .app.
		expect(first.code).toBe('unavailable');
		return;
	}
	expect(first).toMatchObject({ id: 'e2e-1', scheduled: false });
	type Info = { id: string; body: string; url?: string; data?: unknown };
	// Same id → replaced, not duplicated; replace: false keeps the existing one.
	await app.eval(`host.notifications.show({ id: 'e2e-1', title: 'E2E', body: 'two', url: '/about', data: { n: 2 } })`);
	expect(await app.eval(`host.notifications.show({ id: 'e2e-1', title: 'E2E', body: 'three', replace: false })`)).toMatchObject({ skipped: true });
	const delivered = (await app.eval<Info[]>('host.notifications.delivered()')).filter((n) => n.id === 'e2e-1');
	expect(delivered).toEqual([expect.objectContaining({ id: 'e2e-1', body: 'two', url: '/about', data: { n: 2 } })]);
	// Images: data: URLs (and app URLs, fetched by the page) become attachments.
	const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
	expect(await app.eval(`host.notifications.show({ id: 'e2e-img', title: 'Image', image: ${JSON.stringify(png)} })`)).toMatchObject({ id: 'e2e-img' });
	// Scheduled: pending (with the next date), then cancelled.
	const at = Date.now() + 60_000;
	expect(await app.eval(`host.notifications.show({ id: 'e2e-later', title: 'Later', at: ${at} })`)).toMatchObject({ scheduled: true });
	await app.eval(`host.notifications.show({ id: 'e2e-daily', title: 'Daily', at: ${at}, repeat: 'day', data: 'd' })`);
	const pending = await app.eval<{ id: string; at: string; repeat?: string; data?: unknown }[]>('host.notifications.pending()');
	const later = pending.find((p) => p.id === 'e2e-later')!;
	expect(Math.abs(new Date(later.at).getTime() - at)).toBeLessThan(2000);
	expect(pending.find((p) => p.id === 'e2e-daily')).toMatchObject({ repeat: 'day', data: 'd' });
	await app.eval(`host.notifications.cancel('e2e-later')`);
	expect((await app.eval<{ id: string }[]>('host.notifications.pending()')).map((p) => p.id)).not.toContain('e2e-later');

	// A click navigates the window that showed it to the notification's url, and reaches listeners.
	await app.platform('notifications', 'simulateResponse', { id: 'e2e-1' });
	await app.waitFor(() => location.pathname === '/about', { timeout: 5000 });
	await app.waitFor(() => /click e2e-1/.test(document.querySelector('#notification-log')?.textContent ?? ''));
	// Actions: their own url; a reply carries the text.
	await app.eval(`host.notifications.show({ id: 'e2e-chat', title: 'Alice', body: 'Lunch?', url: '/about',
		actions: [{ id: 'reply', title: 'Reply', input: { placeholder: 'Message' } }, { id: 'home', title: 'Home', url: '/' }] })`);
	await app.platform('notifications', 'simulateResponse', { id: 'e2e-chat', actionId: 'reply', input: 'on my way' });
	await app.waitFor(() => /reply e2e-chat reply: on my way/.test(document.querySelector('#notification-log')?.textContent ?? ''));
	await app.platform('notifications', 'simulateResponse', { id: 'e2e-chat', actionId: 'home' });
	await app.waitFor(() => location.pathname === '/', { timeout: 5000 });

	// Cold start: a click while no page is loaded waits for the next page, which claims it.
	await app.platform('notifications', 'simulateResponse', { id: 'e2e-1', cold: true });
	await Bun.sleep(300);
	expect(await app.eval('location.pathname')).toBe('/');
	await app.eval('(location.reload(), true)');
	await app.waitFor(() => location.pathname === '/about', { timeout: 10000 });
	await app.waitFor(() => /click e2e-1/.test(document.querySelector('#notification-log')?.textContent ?? ''));
	// Server code sees every response (replayed at start too).
	const seen = await app.eval<{ kind: string; id: string }[]>(`fetch('/api/notifications').then((r) => r.json())`);
	expect(seen.map((r) => `${r.kind} ${r.id}`)).toEqual(expect.arrayContaining(['click e2e-1', 'reply e2e-chat', 'action e2e-chat']));

	await app.eval('host.notifications.setBadge(3)');
	await app.eval('host.notifications.setBadge(null)');
	await app.eval('host.notifications.dismissAll()');
	expect(await app.eval('host.notifications.delivered()')).toEqual([]);
	expect(await app.eval('host.notifications.pending()')).toEqual([]);
});

test('self-hosted push (push.server): register, end-to-end encrypted delivery, dedupe by id, tap deep-links', async () => {
	const { servePush } = await import('@svelte-desktop/shell/push-server');
	const { createPush, generateVapidKeys } = await import('@svelte-desktop/shell/push');
	const server = servePush({ port: 47123, hostname: '127.0.0.1' });
	try {
		await app.eval(`(window.__pm = [], host.push.on('message', (m) => window.__pm.push(m)), true)`);
		const target = await app.eval<{ provider: string; endpoint: string; keys: { p256dh: string; auth: string } }>('host.push.register()');
		expect(target.provider).toBe('webpush');
		expect(target.endpoint).toStartWith('http://127.0.0.1:47123/v1/push/');
		for (let i = 0; i < 100 && server.push.connected() === 0; i++) await Bun.sleep(50);
		expect(server.push.connected()).toBe(1); // the app's server process holds the connection
		const push = createPush({ webpush: { ...(await generateVapidKeys()), subject: 'mailto:ops@example.com' } });
		await push.send(target as never, { id: 'sh-1', title: 'Self-hosted', body: 'one', url: '/about', data: { n: 1 } });
		await app.waitFor(() => (window as any).__pm.some((m: { id: string }) => m.id === 'sh-1'), { timeout: 10_000 });
		const message = (await app.eval<{ id: string; url?: string; data?: unknown; notification?: { title: string } }[]>('window.__pm'))[0];
		expect(message).toMatchObject({ id: 'sh-1', url: '/about', data: { n: 1 }, notification: { title: 'Self-hosted' } });
		if (process.env.DESKTOP_TEST_DEV) return; // unbundled: no native notification center
		await push.send(target as never, { id: 'sh-1', title: 'Self-hosted', body: 'two', url: '/about' });
		await app.waitFor(() => (window as any).__pm.length >= 2, { timeout: 10_000 });
		const shown = (await app.eval<{ id: string; body: string }[]>('host.notifications.delivered()')).filter((n) => n.id === 'sh-1');
		expect(shown).toEqual([expect.objectContaining({ body: 'two', url: '/about' })]);
		await app.platform('notifications', 'simulateResponse', { id: 'sh-1' });
		await app.waitFor(() => location.pathname === '/about', { timeout: 5000 });
		await app.eval('host.notifications.dismissAll()');
		await app.eval('host.push.unregister()');
		expect(await app.eval('host.push.token()')).toBeNull();
	} finally {
		server.stop(true);
	}
});

test('quitOnLastWindowClosed: false — closing the last window hides it; the app and its push connection live on; a click shows it and deep-links', async () => {
	if (process.env.DESKTOP_TEST_DEV) return; // vite dev owns the window lifecycle
	const { servePush } = await import('@svelte-desktop/shell/push-server');
	const { createPush, generateVapidKeys } = await import('@svelte-desktop/shell/push');
	const server = servePush({ port: 47123, hostname: '127.0.0.1' });
	try {
		const target = await app.eval<never>('host.push.register()');
		for (let i = 0; i < 100 && server.push.connected() === 0; i++) await Bun.sleep(50);
		await app.platform('window', 'close', { windowId: 0 });
		await Bun.sleep(1000);
		// Hidden (not destroyed: page and state kept), the app still running and connected.
		expect(await app.platform<boolean>('window', 'isVisible', { windowId: 0 })).toBe(false);
		expect(server.push.connected()).toBe(1);
		const push = createPush({ webpush: { ...(await generateVapidKeys()), subject: 'mailto:ops@example.com' } });
		await push.send(target, { id: 'closed-1', title: 'While closed', body: 'still delivered', url: '/about' });
		let delivered: { id: string }[] = [];
		for (let i = 0; i < 100 && !delivered.some((n) => n.id === 'closed-1'); i++) {
			delivered = await app.platform<{ id: string }[]>('notifications', 'delivered');
			await Bun.sleep(100);
		}
		expect(delivered.map((n) => n.id)).toContain('closed-1');
		// The click shows the window again; its page (still loaded) navigates.
		await app.platform('notifications', 'simulateResponse', { id: 'closed-1' });
		await app.waitFor(() => location.pathname === '/about', { timeout: 15_000 });
		expect(await app.platform<boolean>('window', 'isVisible', { windowId: 0 })).toBe(true);
		expect(await app.platform<unknown[]>('window', 'list')).toHaveLength(1);
		await app.eval('host.notifications.dismissAll()');
		await app.eval('host.push.unregister()');
	} finally {
		server.stop(true);
	}
});
