import { describe, test, expect, beforeEach } from 'bun:test';
import {
	callPlatform,
	initPlatformForTests,
	onPlatform,
	oncePlatform,
	onAnyPlatform,
	emitTo,
	onWindow,
	NativeApiError,
	platformReady,
	Channel,
} from './bus';
import {
	app as appSvc, clipboard as clipboardSvc, dialog, theme as themeSvc, windows,
	tray as traySvc, shortcuts as shortcutsSvc, power as powerSvc,
	system as systemSvc, screen as screenSvc, menu as menuSvc, shell,
	capture as captureSvc, secureStorage as secureStorageSvc,
} from './index';
import {
	app, window, windowState, screen, clipboard, theme, system, power,
	deepLink, menu, notifications, capture, diagnostics, capabilities, update,
	tray, shortcuts, store, events,
	initStores,
} from 'svelte-desktop/stores';
import { LogicalPosition, PhysicalPosition, LogicalSize, PhysicalSize } from './dpi';
import { dispatchPayload, PLATFORM_EVENT_ID } from '@svelte-desktop/gpuix/gdom';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';

/** Fake napi transport: records requests, serves canned replies.
 *  Queue replies take precedence; otherwise the `service.op` map answers. */
class FakeTransport {
	requests: { id: number; service: string; op: string; args: Record<string, unknown> }[] = [];
	private queue: string[] = [];
	replies = new Map<string, unknown>();

	pushReply(reply: unknown) {
		this.queue.push(JSON.stringify(reply));
	}
	pushRaw(raw: string) {
		this.queue.push(raw);
	}
	/** Sticky reply for every `service.op` call — for multi-call inits. */
	serve(service: string, op: string, reply: unknown) {
		this.replies.set(`${service}.${op}`, reply);
	}
	platformCall(request: string): string {
		const parsed = JSON.parse(request);
		this.requests.push(parsed);
		const canned = this.queue.shift() ?? JSON.stringify(this.replies.get(`${parsed.service}.${parsed.op}`) ?? { ok: true, value: null });
		return canned;
	}
}

let transport: FakeTransport;

beforeEach(() => {
	transport = new FakeTransport();
	initPlatformForTests(transport);
});

function pushPlatformEvent(eventType: string, data: unknown) {
	dispatchPayload({
		elementId: PLATFORM_EVENT_ID,
		eventType: `platform:${eventType}`,
		data,
	} as never);
}

describe('callPlatform envelope', () => {
	test('resolves ok replies with the value', async () => {
		transport.pushReply({ ok: true, value: { name: 'gpuix' } });
		const value = await callPlatform<{ name: string }>('app', 'getInfo');
		expect(value.name).toBe('gpuix');
		expect(transport.requests[0]).toMatchObject({ service: 'app', op: 'getInfo', args: {} });
	});

	test('rejects ok:false replies with NativeApiError carrying the code', async () => {
		transport.pushReply({ ok: false, error: { code: 'denied', message: 'nope' } });
		const caught = (await callPlatform('capture', 'getSources').catch((e) => e)) as NativeApiError;
		expect(caught).toBeInstanceOf(NativeApiError);
		expect(caught.code).toBe('denied');
		expect(caught.message).toBe('nope');
	});

	test('malformed transport output rejects as internal', async () => {
		transport.pushRaw('not json{');
		const caught = (await callPlatform('app', 'getInfo').catch((e) => e)) as NativeApiError;
		expect(caught.code).toBe('internal');
	});

	test('sends incrementing call ids', async () => {
		transport.pushReply({ ok: true, value: 1 });
		transport.pushReply({ ok: true, value: 2 });
		await callPlatform('app', 'getName');
		await callPlatform('app', 'getName');
		expect(transport.requests[1]!.id).toBe(transport.requests[0]!.id + 1);
	});
});

describe('pending calls resolve via platformResult events', () => {
	test('pending → ok result resolves the promise', async () => {
		transport.pushReply({ pending: true, id: 0 }); // id field ignored; bus uses its own
		const promise = callPlatform<string>('secureStorage', 'getPassword');
		const { id } = transport.requests[0]!;
		pushPlatformEvent('platformResult', { id, ok: true, value: 'hunter2' });
		expect(await promise).toBe('hunter2');
	});

	test('pending → error result rejects with the envelope code', async () => {
		transport.pushReply({ pending: true, id: 0 });
		const promise = callPlatform('dialog', 'showOpenDialog');
		const { id } = transport.requests[0]!;
		pushPlatformEvent('platformResult', {
			id,
			ok: false,
			error: { code: 'denied', message: 'user canceled' },
		});
		const caught = (await promise.catch((e) => e)) as NativeApiError;
		expect(caught.code).toBe('denied');
	});

	test('late results for unknown ids are dropped silently', async () => {
		transport.pushReply({ ok: true, value: null });
		await callPlatform('app', 'getName');
		// no pending entry for 999 — must not throw
		pushPlatformEvent('platformResult', { id: 999, ok: true, value: null });
	});
});

describe('platform events', () => {
	test('onPlatform receives the data payload', () => {
		const seen: unknown[] = [];
		onPlatform('appearanceChanged', (d) => seen.push(d));
		pushPlatformEvent('appearanceChanged', { appearance: 'dark', dark: true });
		expect(seen).toEqual([{ appearance: 'dark', dark: true }]);
	});

	test('unsubscribe stops delivery', () => {
		const seen: unknown[] = [];
		const off = onPlatform('systemWake', (d) => seen.push(d));
		off();
		pushPlatformEvent('systemWake', {});
		expect(seen).toEqual([]);
	});

	test('onAnyPlatform sees name + data', () => {
		const seen: string[] = [];
		const off = onAnyPlatform((name) => seen.push(name));
		pushPlatformEvent('openUrls', { urls: ['gpuix://x'] });
		off();
		expect(seen).toEqual(['openUrls']);
	});
});

describe('typed service wrappers', () => {
	test('app.getPath forwards the path name', async () => {
		transport.pushReply({ ok: true, value: '/Users/x/Library' });
		expect(await appSvc.getPath('userData')).toBe('/Users/x/Library');
		expect(transport.requests[0]!.args).toEqual({ name: 'userData' });
	});

	test('windows.setSize forwards width/height', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.setSize(800, 600);
		expect(transport.requests[0]).toMatchObject({
			service: 'window',
			op: 'setSize',
			args: { width: 800, height: 600 },
		});
	});

	test('clipboard.writeText forwards text', async () => {
		transport.pushReply({ ok: true, value: null });
		await clipboardSvc.writeText('hello');
		expect(transport.requests[0]!.args).toEqual({ text: 'hello' });
	});

	test('dialog.showMessageBox accepts a bare message string', async () => {
		transport.pushReply({ ok: true, value: { response: 0, canceled: false } });
		const result = await dialog.showMessageBox('Quit?');
		expect(transport.requests[0]!.args).toEqual({ message: 'Quit?' });
		expect(result.response).toBe(0);
	});

	test('theme.onChange subscribes to appearanceChanged', () => {
		const seen: unknown[] = [];
		themeSvc.onChange((info) => seen.push(info));
		pushPlatformEvent('appearanceChanged', { appearance: 'vibrantDark', dark: true });
		expect((seen[0] as { dark: boolean }).dark).toBe(true);
	});
});

describe('reactive namespaces (svelte-desktop/stores)', () => {
	test('windowState.init loads persisted JSON', async () => {
		const dir = mkdtempSync('/tmp/wstate-test-');
		try {
			transport.serve('app', 'getPath', { ok: true, value: dir });
			await windowState.init();
			expect(windowState.ready).toBe(true);
			expect(windowState.persisted).toBe(null); // no state file yet
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('save() updates persisted $state with the written JSON', async () => {
		const dir = mkdtempSync('/tmp/wstate-test-');
		try {
			transport.pushReply({ ok: true, value: { bounds: { x: 5, y: 6, width: 1024, height: 768 }, state: 'normal' } }); // getBounds
			transport.pushReply({ ok: true, value: dir }); // getPath(userData) for the file write
			const saved = await windowState.save();
			expect(saved.bounds.width).toBe(1024);
			expect(windowState.persisted?.bounds.width).toBe(1024);
			expect(windowState.saving).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('theme.init + appearanceChanged event drives $state', async () => {
		transport.serve('theme', 'get', { ok: true, value: { appearance: 'light', dark: false } });
		await theme.init();
		expect(theme.current?.appearance).toBe('light');
		expect(theme.dark).toBe(false);
		pushPlatformEvent('appearanceChanged', { appearance: 'dark', dark: true });
		expect(theme.current?.appearance).toBe('dark');
		expect(theme.dark).toBe(true);
		theme.dispose();
	});

	test('initStores() populates every store and isolates failures', async () => {
		transport.serve('app', 'getInfo', { ok: true, value: { name: 'probe', version: '1.0', identifier: 'x', appPath: '/x', packaged: false, platform: 'macos', arch: 'aarch64' } });
		transport.serve('window', 'getBounds', { ok: true, value: { bounds: { x: 0, y: 0, width: 800, height: 600 }, state: 'normal' } });
		transport.serve('window', 'getTitle', { ok: true, value: 'probe window' });
		transport.serve('screen', 'getAllDisplays', { ok: true, value: [{ id: 1, uuid: null, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 25, width: 2560, height: 1415 }, isPrimary: true }] });
		transport.serve('screen', 'getPrimaryDisplay', { ok: true, value: { id: 1, isPrimary: true } });
		transport.serve('clipboard', 'readText', { ok: true, value: 'clip' });
		transport.serve('clipboard', 'availableFormats', { ok: true, value: ['text/plain'] });
		transport.serve('clipboard', 'readHtml', { ok: true, value: '<b>clip</b>' });
		transport.serve('clipboard', 'readRtf', { ok: true, value: '{\\rtf1 clip}' });
		transport.serve('system', 'info', { ok: true, value: { os: 'macos', family: 'unix', arch: 'aarch64', keyboardLayout: 'US' } });
		transport.serve('system', 'getAccentColor', { ok: true, value: { r: 0, g: 0.478, b: 1, a: 1 } });
		transport.serve('system', 'getAccessibility', { ok: true, value: { reduceMotion: true, highContrast: false, differentiateWithoutColor: false, reduceTransparency: true } });
		transport.serve('power', 'getThermalState', { ok: true, value: { state: 'nominal' } });
		transport.serve('power', 'getBattery', { ok: true, value: { percent: 88, charging: false, external: true } });
		transport.serve('capture', 'isSupported', { ok: true, value: { supported: false } });
		transport.serve('capture', 'getSources', { ok: false, error: { code: 'unavailable', message: 'feature off' } });
		transport.serve('diagnostics', 'info', { ok: true, value: { pid: 1, uptimeSeconds: 2, os: 'macos', family: 'unix', arch: 'aarch64', renderer: 'gpuix', rendererVersion: '0' } });
		transport.serve('capabilities', 'describe', { ok: true, value: { platform: 'macos', arch: 'aarch64', services: { clipboard: { readText: 'implemented' } } } });
		transport.serve('app', 'getPath', { ok: true, value: '/tmp' });

		await initStores();

		expect(app.name).toBe('probe');
		expect(window.bounds?.width).toBe(800);
		expect(window.title).toBe('probe window');
		expect(screen.displays.length).toBe(1);
		expect(screen.primary?.isPrimary).toBe(true);
		expect(clipboard.text).toBe('clip');
		expect(clipboard.hasText).toBe(true);
		expect(system.layout).toBe('US');
		expect(system.accentColor).toEqual({ r: 0, g: 0.478, b: 1, a: 1 });
		expect(system.accessibility?.reduceMotion).toBe(true);
		expect(system.accessibility?.reduceTransparency).toBe(true);
		expect(power.thermal).toBe('nominal');
		expect(power.battery).toEqual({ percent: 88, charging: false, external: true });
		expect(clipboard.html).toBe('<b>clip</b>');
		expect(clipboard.rtf).toBe('{\\rtf1 clip}');
		expect(diagnostics.pid).toBe(1);
		expect(capabilities.opStatus('clipboard', 'readText')).toBe('implemented');
		expect(capture.supported).toBe(false); // unsupported → no getSources call needed
		expect(update.ready).toBe(true);
		expect(deepLink.ready).toBe(true);
		expect(tray.ready).toBe(true);
		expect(shortcuts.ready).toBe(true);
	});

	test('namespace .on() delivers typed platform events + unsubscribes', async () => {
		const seen: string[] = [];
		const off = menu.on('menuAction', ({ id }: { id: string }) => seen.push(id));
		pushPlatformEvent('menuAction', { id: 'probe.a' });
		off();
		pushPlatformEvent('menuAction', { id: 'probe.b' });
		expect(seen).toEqual(['probe.a']);

		const tags: string[] = [];
		notifications.on('notificationResponse', ({ tag }: { tag: string }) => tags.push(tag));
		pushPlatformEvent('notificationResponse', { tag: 't9', actionId: null });
		expect(tags).toEqual(['t9']);

		let quit = false;
		app.on('willQuit', () => { quit = true; });
		pushPlatformEvent('willQuit', {});
		expect(quit).toBe(true);
	});

	test('platform events feed their stores', async () => {
		pushPlatformEvent('openUrls', { urls: ['gpuix://hello'] });
		expect(deepLink.last).toBe('gpuix://hello');

		pushPlatformEvent('menuAction', { id: 'probe.ping' });
		expect(menu.lastAction).toBe('probe.ping');

		pushPlatformEvent('notificationResponse', { tag: 't1', actionId: 'reply' });
		expect(notifications.lastResponse).toEqual({ tag: 't1', actionId: 'reply' });

		// Relative — earlier tests may have pushed systemWake while power's
		// handler was already subscribed (auto-init binds at first mock).
		const wakes = power.wakeCount;
		pushPlatformEvent('systemWake', {});
		expect(power.wakeCount).toBe(wakes + 1);

		pushPlatformEvent('willQuit', {});
		expect(app.quitting).toBe(true);

		pushPlatformEvent('reopened', {});
		expect(app.reopenCount).toBe(1);

		// keyboardLayoutChanged re-pulls through the service
		transport.pushReply({ ok: true, value: { name: 'French' } });
		pushPlatformEvent('keyboardLayoutChanged', {});
		await new Promise((r) => setTimeout(r, 0));
		expect(system.layout).toBe('French');

		// thermalStateChanged re-pulls too
		transport.pushReply({ ok: true, value: { state: 'critical' } });
		pushPlatformEvent('thermalStateChanged', {});
		await new Promise((r) => setTimeout(r, 0));
		expect(power.thermal).toBe('critical');
	});
});

describe('lifecycle', () => {
	test('platformReady reflects init', () => {
		expect(platformReady()).toBe(true);
	});
});

describe('new service ops', () => {
	test('tray.set forwards options; tray.remove hits tray.remove', async () => {
		transport.pushReply({ ok: true, value: { set: true } });
		const res = await traySvc.set({
			title: 'hi',
			tooltip: 'tip',
			menu: { items: [{ id: 'a', label: 'A' }] },
		});
		expect(res.set).toBe(true);
		expect(transport.requests[0]).toMatchObject({
			service: 'tray',
			op: 'set',
			args: { title: 'hi', tooltip: 'tip', menu: { items: [{ id: 'a', label: 'A' }] } },
		});

		transport.pushReply({ ok: true, value: null });
		await traySvc.remove();
		expect(transport.requests[1]).toMatchObject({ service: 'tray', op: 'remove', args: {} });
	});

	test('shortcuts register/unregister/unregisterAll forward ids', async () => {
		transport.pushReply({ ok: true, value: { id: 'accel-1' } });
		expect(await shortcutsSvc.register({ accelerator: 'CmdOrCtrl+K', id: 'palette' }))
			.toEqual({ id: 'accel-1' });
		expect(transport.requests[0]).toMatchObject({
			service: 'shortcuts',
			op: 'register',
			args: { accelerator: 'CmdOrCtrl+K', id: 'palette' },
		});

		transport.pushReply({ ok: true, value: null });
		await shortcutsSvc.unregister({ id: 'accel-1' });
		expect(transport.requests[1]).toMatchObject({
			service: 'shortcuts',
			op: 'unregister',
			args: { id: 'accel-1' },
		});

		transport.pushReply({ ok: true, value: null });
		await shortcutsSvc.unregisterAll();
		expect(transport.requests[2]).toMatchObject({ service: 'shortcuts', op: 'unregisterAll' });
	});

	test('window.setPosition/getPosition', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.setPosition(10, 20);
		expect(transport.requests[0]).toMatchObject({
			service: 'window',
			op: 'setPosition',
			args: { x: 10, y: 20 },
		});

		transport.pushReply({ ok: true, value: { x: 30, y: 40 } });
		expect(await windows.getPosition()).toEqual({ x: 30, y: 40 });
		expect(transport.requests[1]).toMatchObject({ service: 'window', op: 'getPosition' });
	});

	test('power battery + sleep blockers', async () => {
		transport.pushReply({ ok: true, value: { percent: 55, charging: true, external: true } });
		expect(await powerSvc.getBattery()).toEqual({ percent: 55, charging: true, external: true });
		expect(transport.requests[0]).toMatchObject({ service: 'power', op: 'getBattery' });

		transport.pushReply({ ok: true, value: { id: 7 } });
		expect(await powerSvc.blockSleep({ type: 'display', reason: 'rendering' }))
			.toEqual({ id: 7 });
		expect(transport.requests[1]).toMatchObject({
			service: 'power',
			op: 'blockSleep',
			args: { type: 'display', reason: 'rendering' },
		});

		transport.pushReply({ ok: true, value: null });
		await powerSvc.unblockSleep(7);
		expect(transport.requests[2]).toMatchObject({
			service: 'power',
			op: 'unblockSleep',
			args: { id: 7 },
		});
	});

	test('system.getAccentColor/getAccessibility', async () => {
		transport.pushReply({ ok: true, value: { r: 255, g: 0, b: 0, a: 255 } });
		expect(await systemSvc.getAccentColor()).toEqual({ r: 255, g: 0, b: 0, a: 255 });
		expect(transport.requests[0]).toMatchObject({ service: 'system', op: 'getAccentColor' });

		transport.pushReply({
			ok: true,
			value: { reduceMotion: false, highContrast: true, differentiateWithoutColor: false, reduceTransparency: false },
		});
		expect((await systemSvc.getAccessibility()).highContrast).toBe(true);
		expect(transport.requests[1]).toMatchObject({ service: 'system', op: 'getAccessibility' });
	});

	test('app dock/login/activation/single-instance ops', async () => {
		transport.pushReply({ ok: true, value: null });
		await appSvc.setDockBadge('3');
		expect(transport.requests[0]).toMatchObject({
			service: 'app',
			op: 'setDockBadge',
			args: { text: '3' },
		});

		transport.pushReply({ ok: true, value: null });
		await appSvc.bounceDock('critical');
		expect(transport.requests[1]).toMatchObject({
			service: 'app',
			op: 'bounceDock',
			args: { type: 'critical' },
		});

		transport.pushReply({ ok: true, value: { enabled: true } });
		expect(await appSvc.setLoginItem(true)).toEqual({ enabled: true });
		expect(transport.requests[2]).toMatchObject({
			service: 'app',
			op: 'setLoginItem',
			args: { enabled: true },
		});

		transport.pushReply({ ok: true, value: null });
		await appSvc.setActivationPolicy('accessory');
		expect(transport.requests[3]).toMatchObject({
			service: 'app',
			op: 'setActivationPolicy',
			args: { policy: 'accessory' },
		});

		transport.pushReply({ ok: true, value: { acquired: true } });
		expect(await appSvc.requestSingleInstanceLock()).toEqual({ acquired: true });
		expect(transport.requests[4]).toMatchObject({ service: 'app', op: 'requestSingleInstanceLock' });
	});

	test('clipboard html/rtf read+write', async () => {
		transport.pushReply({ ok: true, value: '<b>x</b>' });
		expect(await clipboardSvc.readHtml()).toBe('<b>x</b>');
		expect(transport.requests[0]).toMatchObject({ service: 'clipboard', op: 'readHtml' });

		transport.pushReply({ ok: true, value: null });
		await clipboardSvc.writeHtml('<i>y</i>');
		expect(transport.requests[1]).toMatchObject({
			service: 'clipboard',
			op: 'writeHtml',
			args: { html: '<i>y</i>' },
		});

		transport.pushReply({ ok: true, value: '{\\rtf1 z}' });
		expect(await clipboardSvc.readRtf()).toBe('{\\rtf1 z}');
		expect(transport.requests[2]).toMatchObject({ service: 'clipboard', op: 'readRtf' });

		transport.pushReply({ ok: true, value: null });
		await clipboardSvc.writeRtf('{\\rtf1 w}');
		expect(transport.requests[3]).toMatchObject({
			service: 'clipboard',
			op: 'writeRtf',
			args: { rtf: '{\\rtf1 w}' },
		});
	});

	test('shell.trashItem/beep', async () => {
		transport.pushReply({ ok: true, value: null });
		await shell.trashItem('/tmp/x');
		expect(transport.requests[0]).toMatchObject({
			service: 'shell',
			op: 'trashItem',
			args: { path: '/tmp/x' },
		});

		transport.pushReply({ ok: true, value: null });
		await shell.beep();
		expect(transport.requests[1]).toMatchObject({ service: 'shell', op: 'beep' });
	});

	test('menu.popup forwards items + position', async () => {
		// The wire value is always true — AppKit can't distinguish a pick
		// from a dismissal; menuAction is the real selection signal.
		transport.pushReply({ ok: true, value: { dismissed: true } });
		const res = await menuSvc.popup({ items: [{ id: 'a', label: 'A' }], x: 5, y: 6 });
		expect(res.dismissed).toBe(true);
		expect(transport.requests[0]).toMatchObject({
			service: 'menu',
			op: 'popup',
			args: { items: [{ id: 'a', label: 'A' }], x: 5, y: 6 },
		});
	});

	test('dialog open/save forward filters', async () => {
		transport.pushReply({ ok: true, value: { canceled: false, paths: ['/x.png'] } });
		await dialog.showOpenDialog({
			files: true,
			filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
		});
		expect(transport.requests[0]!.args).toEqual({
			files: true,
			filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
		});

		transport.pushReply({ ok: true, value: { canceled: false, path: '/x.png' } });
		await dialog.showSaveDialog({
			suggestedName: 'x.png',
			filters: [{ name: 'Images', extensions: ['png'] }],
		});
		expect(transport.requests[1]!.args).toEqual({
			suggestedName: 'x.png',
			filters: [{ name: 'Images', extensions: ['png'] }],
		});
	});
});

describe('reactive namespaces — new surfaces', () => {
	test('boundsChanged merges into window.live.bounds + position getter', async () => {
		transport.serve('window', 'getBounds', {
			ok: true,
			value: { bounds: { x: 0, y: 0, width: 800, height: 600 }, state: 'normal' },
		});
		await window.init();
		pushPlatformEvent('boundsChanged', { x: 10, y: 20, width: 1024, height: 768 });
		expect(window.live).toEqual({
			bounds: { x: 10, y: 20, width: 1024, height: 768 },
			state: 'normal',
		});
		expect(window.position).toEqual({ x: 10, y: 20 });
	});

	test('window.setPosition writes through + updates position', async () => {
		transport.serve('window', 'getBounds', {
			ok: true,
			value: { bounds: { x: 0, y: 0, width: 800, height: 600 }, state: 'normal' },
		});
		await window.init();
		transport.pushReply({ ok: true, value: null });
		await window.setPosition(50, 60);
		expect(window.position).toEqual({ x: 50, y: 60 });
		expect(transport.requests.at(-1)).toMatchObject({
			service: 'window',
			op: 'setPosition',
			args: { x: 50, y: 60 },
		});
	});

	test('displaysChanged re-pulls screen.displays', async () => {
		transport.serve('screen', 'getAllDisplays', {
			ok: true,
			value: [
				{ id: 1, uuid: null, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 25, width: 2560, height: 1415 }, isPrimary: true },
			],
		});
		await screen.init();
		expect(screen.displays.length).toBe(1);

		transport.serve('screen', 'getAllDisplays', {
			ok: true,
			value: [
				{ id: 1, uuid: null, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 25, width: 2560, height: 1415 }, isPrimary: true },
				{ id: 2, uuid: null, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, workArea: { x: 2560, y: 0, width: 1920, height: 1080 }, isPrimary: false },
			],
		});
		pushPlatformEvent('displaysChanged', {});
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.displays.length).toBe(2);
	});

	test('shortcutPressed reaches shortcuts.on with typed {id}', () => {
		const seen: string[] = [];
		const off = shortcuts.on('shortcutPressed', ({ id }: { id: string }) => seen.push(id));
		pushPlatformEvent('shortcutPressed', { id: 'accel-1' });
		off();
		pushPlatformEvent('shortcutPressed', { id: 'accel-2' });
		expect(seen).toEqual(['accel-1']);
	});

	test('tray store echoes set() args, toggles active, exposes trayClick', async () => {
		const clicks: number[] = [];
		const off = tray.on('trayClick', () => clicks.push(1));
		pushPlatformEvent('trayClick', {});
		off();
		expect(clicks).toEqual([1]);

		transport.pushReply({ ok: true, value: { set: true } });
		const res = await tray.set({ title: 't', tooltip: 'tip', imagePath: '/icon.png' });
		expect(res).toBe(true);
		expect(tray.active).toBe(true);
		expect(tray.title).toBe('t');
		expect(tray.tooltip).toBe('tip');
		expect(tray.imagePath).toBe('/icon.png');
		expect(transport.requests.at(-1)).toMatchObject({ service: 'tray', op: 'set' });

		transport.pushReply({ ok: true, value: null });
		await tray.remove();
		expect(tray.active).toBe(false);
	});

	test('shortcuts store tracks registered ids', async () => {
		transport.pushReply({ ok: true, value: null });
		await shortcuts.unregisterAll();
		expect(shortcuts.registered).toEqual([]);

		transport.pushReply({ ok: true, value: { id: 's1' } });
		const r = await shortcuts.register({ accelerator: 'CmdOrCtrl+K', id: 's1' });
		expect(r.id).toBe('s1');
		transport.pushReply({ ok: true, value: { id: 's2' } });
		await shortcuts.register({ accelerator: 'CmdOrCtrl+L' });
		expect(shortcuts.registered).toEqual(['s1', 's2']);

		transport.pushReply({ ok: true, value: null });
		await shortcuts.unregister({ id: 's1' });
		expect(shortcuts.registered).toEqual(['s2']);

		transport.pushReply({ ok: true, value: null });
		await shortcuts.unregisterAll();
		expect(shortcuts.registered).toEqual([]);
	});

	test('clipboard html/rtf state follows reads and own writes', async () => {
		transport.serve('clipboard', 'readText', { ok: true, value: null });
		transport.serve('clipboard', 'availableFormats', { ok: true, value: [] });
		transport.serve('clipboard', 'readHtml', { ok: true, value: '<b>hi</b>' });
		transport.serve('clipboard', 'readRtf', { ok: true, value: '{\\rtf1 hi}' });
		await clipboard.init();
		expect(clipboard.html).toBe('<b>hi</b>');
		expect(clipboard.rtf).toBe('{\\rtf1 hi}');

		transport.pushReply({ ok: true, value: null });
		await clipboard.writeHtml('<i>w</i>');
		expect(clipboard.html).toBe('<i>w</i>');

		transport.pushReply({ ok: true, value: null });
		await clipboard.writeRtf('{\\rtf1 w}');
		expect(clipboard.rtf).toBe('{\\rtf1 w}');
	});

	test('app.setDockBadge echoes into dockBadge state; secondInstance counted', async () => {
		transport.pushReply({ ok: true, value: null });
		await app.setDockBadge('5');
		expect(app.dockBadge).toBe('5');
		expect(transport.requests.at(-1)).toMatchObject({
			service: 'app',
			op: 'setDockBadge',
			args: { text: '5' },
		});
		transport.pushReply({ ok: true, value: null });
		await app.setDockBadge(null);
		expect(app.dockBadge).toBe(null);

		const before = app.secondInstanceCount;
		pushPlatformEvent('secondInstance', {});
		expect(app.secondInstanceCount).toBe(before + 1);
	});

	test('power.blockSleep passes through to the service', async () => {
		transport.pushReply({ ok: true, value: { id: 3 } });
		expect(await power.blockSleep({ type: 'system' })).toEqual({ id: 3 });
		transport.pushReply({ ok: true, value: null });
		await power.unblockSleep(3);
		expect(transport.requests.at(-1)).toMatchObject({
			service: 'power',
			op: 'unblockSleep',
			args: { id: 3 },
		});
	});
});

describe('window.* geometry + state ops', () => {
	test('center/hide/show/setBounds/positionTo op shapes', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.center();
		expect(transport.requests[0]).toMatchObject({ service: 'window', op: 'center' });

		transport.pushReply({ ok: true, value: null });
		await windows.hide();
		expect(transport.requests[1]).toMatchObject({ service: 'window', op: 'hide' });

		transport.pushReply({ ok: true, value: null });
		await windows.show();
		expect(transport.requests[2]).toMatchObject({ service: 'window', op: 'show' });

		transport.pushReply({ ok: true, value: null });
		await windows.setBounds(1, 2, 800, 600);
		expect(transport.requests[3]).toMatchObject({
			service: 'window',
			op: 'setBounds',
			args: { x: 1, y: 2, width: 800, height: 600 },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.positionTo('trayCenter');
		expect(transport.requests[4]).toMatchObject({
			service: 'window',
			op: 'positionTo',
			args: { preset: 'trayCenter' },
		});
	});

	test('controlsArea op shape', async () => {
		transport.pushReply({
			ok: true,
			value: {
				x: 9, y: 8, width: 60, height: 14, contentTop: 0, side: 'left',
				buttons: { close: { x: 9, y: 8, width: 14, height: 14, visible: true } },
			},
		});
		const area = await windows.getControlsArea();
		expect(area?.side).toBe('left');
		expect(transport.requests[0]).toMatchObject({ service: 'window', op: 'controlsArea' });

		transport.pushReply({ ok: true, value: null });
		expect(await windows.getControlsArea(1)).toBeNull();
		expect(transport.requests[1]).toMatchObject({
			service: 'window', op: 'controlsArea', args: { windowId: 1 },
		});
	});

	test('unminimize/isMinimized/restore', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.unminimize();
		expect(transport.requests[0]).toMatchObject({ service: 'window', op: 'unminimize' });

		transport.pushReply({ ok: true, value: { minimized: true } });
		expect(await windows.isMinimized()).toEqual({ minimized: true });
		expect(transport.requests[1]).toMatchObject({ service: 'window', op: 'isMinimized' });

		transport.pushReply({ ok: true, value: null });
		await windows.restore();
		expect(transport.requests[2]).toMatchObject({ service: 'window', op: 'restore' });
	});

	test('simple fullscreen + z-order + hover/active queries', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.setSimpleFullscreen(true);
		expect(transport.requests[0]).toMatchObject({
			service: 'window', op: 'setSimpleFullscreen', args: { enabled: true },
		});

		transport.pushReply({ ok: true, value: { simpleFullscreen: true } });
		expect(await windows.isSimpleFullscreen()).toEqual({ simpleFullscreen: true });

		transport.pushReply({ ok: true, value: null });
		await windows.setAlwaysOnTop(true);
		expect(transport.requests[2]).toMatchObject({
			service: 'window', op: 'setAlwaysOnTop', args: { enabled: true },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.setAlwaysOnBottom(true);
		expect(transport.requests[3]).toMatchObject({
			service: 'window', op: 'setAlwaysOnBottom', args: { enabled: true },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.blur();
		expect(transport.requests[4]).toMatchObject({ service: 'window', op: 'blur' });

		transport.pushReply({ ok: true, value: { hovered: false } });
		expect(await windows.isHovered()).toEqual({ hovered: false });

		transport.pushReply({ ok: true, value: true });
		expect(await windows.isActive()).toBe(true);
	});

	test('chrome toggles set*/is* pairs', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.setResizable(false);
		expect(transport.requests[0]).toMatchObject({
			service: 'window', op: 'setResizable', args: { enabled: false },
		});
		transport.pushReply({ ok: true, value: { resizable: false } });
		expect(await windows.isResizable()).toEqual({ resizable: false });

		transport.pushReply({ ok: true, value: null });
		await windows.setClosable(false);
		expect(transport.requests[2]).toMatchObject({
			service: 'window', op: 'setClosable', args: { enabled: false },
		});
		transport.pushReply({ ok: true, value: { closable: false } });
		expect(await windows.isClosable()).toEqual({ closable: false });

		transport.pushReply({ ok: true, value: null });
		await windows.setMinimizable(false);
		expect(transport.requests[4]).toMatchObject({
			service: 'window', op: 'setMinimizable', args: { enabled: false },
		});
		transport.pushReply({ ok: true, value: { minimizable: false } });
		expect(await windows.isMinimizable()).toEqual({ minimizable: false });

		transport.pushReply({ ok: true, value: null });
		await windows.setMaximizable(false);
		expect(transport.requests[6]).toMatchObject({
			service: 'window', op: 'setMaximizable', args: { enabled: false },
		});
		transport.pushReply({ ok: true, value: { maximizable: false } });
		expect(await windows.isMaximizable()).toEqual({ maximizable: false });
	});

	test('setTitleBarStyle/setDecorations/setHasShadow/invalidateShadow', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.setTitleBarStyle('hiddenInset');
		expect(transport.requests[0]).toMatchObject({
			service: 'window', op: 'setTitleBarStyle', args: { style: 'hiddenInset' },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.setDecorations(false);
		expect(transport.requests[1]).toMatchObject({
			service: 'window', op: 'setDecorations', args: { enabled: false },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.setHasShadow(false);
		expect(transport.requests[2]).toMatchObject({
			service: 'window', op: 'setHasShadow', args: { enabled: false },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.invalidateShadow();
		expect(transport.requests[3]).toMatchObject({ service: 'window', op: 'invalidateShadow' });
	});

	test('opacity/movable/mouse-events/content-protection ops', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.setOpacity(0.5);
		expect(transport.requests[0]).toMatchObject({
			service: 'window', op: 'setOpacity', args: { opacity: 0.5 },
		});
		transport.pushReply({ ok: true, value: { opacity: 0.5 } });
		expect(await windows.getOpacity()).toEqual({ opacity: 0.5 });

		transport.pushReply({ ok: true, value: null });
		await windows.setMovable(false);
		expect(transport.requests[2]).toMatchObject({
			service: 'window', op: 'setMovable', args: { enabled: false },
		});
		transport.pushReply({ ok: true, value: null });
		await windows.setMovableByWindowBackground(true);
		expect(transport.requests[3]).toMatchObject({
			service: 'window', op: 'setMovableByWindowBackground', args: { enabled: true },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.setIgnoresMouseEvents(true);
		expect(transport.requests[4]).toMatchObject({
			service: 'window', op: 'setIgnoresMouseEvents', args: { enabled: true },
		});
		transport.pushReply({ ok: true, value: { ignored: true } });
		expect(await windows.ignoresMouseEvents()).toEqual({ ignored: true });

		transport.pushReply({ ok: true, value: null });
		await windows.setContentProtected(true);
		expect(transport.requests[6]).toMatchObject({
			service: 'window', op: 'setContentProtected', args: { enabled: true },
		});
		transport.pushReply({ ok: true, value: { contentProtected: true } });
		expect(await windows.isContentProtected()).toEqual({ contentProtected: true });

		transport.pushReply({ ok: true, value: null });
		await windows.setVisibleOnAllWorkspaces(true);
		expect(transport.requests[8]).toMatchObject({
			service: 'window', op: 'setVisibleOnAllWorkspaces', args: { enabled: true },
		});
	});

	test('document-edited/cursor/theme/focusable ops', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.setDocumentEdited(true);
		expect(transport.requests[0]).toMatchObject({
			service: 'window', op: 'setDocumentEdited', args: { edited: true },
		});
		transport.pushReply({ ok: true, value: { edited: true } });
		expect(await windows.isDocumentEdited()).toEqual({ edited: true });

		// setEdited aliases setDocumentEdited on the wire
		transport.pushReply({ ok: true, value: null });
		await windows.setEdited(false);
		expect(transport.requests[2]).toMatchObject({
			service: 'window', op: 'setDocumentEdited', args: { edited: false },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.setCursorHidden(true);
		expect(transport.requests[3]).toMatchObject({
			service: 'window', op: 'setCursorHidden', args: { hidden: true },
		});
		transport.pushReply({ ok: true, value: null });
		await windows.setCursorPosition(100, 200);
		expect(transport.requests[4]).toMatchObject({
			service: 'window', op: 'setCursorPosition', args: { x: 100, y: 200 },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.setTheme('dark');
		expect(transport.requests[5]).toMatchObject({
			service: 'window', op: 'setTheme', args: { theme: 'dark' },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.setFocusable(false);
		expect(transport.requests[6]).toMatchObject({
			service: 'window', op: 'setFocusable', args: { enabled: false },
		});
	});

	test('inner/outer size+position + min/max size ops', async () => {
		transport.pushReply({ ok: true, value: { width: 800, height: 600 } });
		expect(await windows.innerSize()).toEqual({ width: 800, height: 600 });
		transport.pushReply({ ok: true, value: { x: 10, y: 20 } });
		expect(await windows.innerPosition()).toEqual({ x: 10, y: 20 });
		transport.pushReply({ ok: true, value: { width: 820, height: 640 } });
		expect(await windows.outerSize()).toEqual({ width: 820, height: 640 });
		transport.pushReply({ ok: true, value: { x: 8, y: 18 } });
		expect(await windows.outerPosition()).toEqual({ x: 8, y: 18 });
		expect(transport.requests.map((r) => r.op)).toEqual([
			'innerSize', 'innerPosition', 'outerSize', 'outerPosition',
		]);

		transport.pushReply({ ok: true, value: null });
		await windows.setMinSize(400, 300);
		expect(transport.requests[4]).toMatchObject({
			service: 'window', op: 'setMinSize', args: { width: 400, height: 300 },
		});
		transport.pushReply({ ok: true, value: null });
		await windows.setMaxSize(0, 0); // 0 clears
		expect(transport.requests[5]).toMatchObject({
			service: 'window', op: 'setMaxSize', args: { width: 0, height: 0 },
		});
	});
});

describe('app/system/capture/menu/secureStorage new ops', () => {
	test('app.setDockProgress/getBundleType/defaultWindowIcon/aboutPanel', async () => {
		transport.pushReply({ ok: true, value: null });
		await appSvc.setDockProgress({ status: 'normal', completed: 3, total: 10 });
		expect(transport.requests[0]).toMatchObject({
			service: 'app',
			op: 'setDockProgress',
			args: { status: 'normal', completed: 3, total: 10 },
		});

		transport.pushReply({ ok: true, value: { type: 'app' } });
		expect(await appSvc.getBundleType()).toEqual({ type: 'app' });
		expect(transport.requests[1]).toMatchObject({ service: 'app', op: 'getBundleType' });

		transport.pushReply({ ok: true, value: { pngBase64: 'aGk=' } });
		expect(await appSvc.defaultWindowIcon()).toEqual({ pngBase64: 'aGk=' });

		transport.pushReply({ ok: true, value: null });
		await appSvc.aboutPanel({ name: 'probe', version: '1.0' });
		expect(transport.requests[3]).toMatchObject({
			service: 'app', op: 'aboutPanel', args: { name: 'probe', version: '1.0' },
		});
	});

	test('system.checkPermission/requestPermission/openSettings', async () => {
		transport.pushReply({ ok: true, value: { status: 'granted' } });
		expect(await systemSvc.checkPermission('accessibility')).toEqual({ status: 'granted' });
		expect(transport.requests[0]).toMatchObject({
			service: 'system', op: 'checkPermission', args: { name: 'accessibility' },
		});

		transport.pushReply({ ok: true, value: { status: 'notDetermined' } });
		expect(await systemSvc.requestPermission('screenRecording')).toEqual({
			status: 'notDetermined',
		});
		expect(transport.requests[1]).toMatchObject({
			service: 'system', op: 'requestPermission', args: { name: 'screenRecording' },
		});

		transport.pushReply({ ok: true, value: null });
		await systemSvc.openSettings('privacy-screenCapture');
		expect(transport.requests[2]).toMatchObject({
			service: 'system', op: 'openSettings', args: { pane: 'privacy-screenCapture' },
		});
	});

	test('secureStorage.authenticate resolves the envelope', async () => {
		transport.pushReply({ ok: true, value: { authenticated: true, reason: 'unlock' } });
		expect(await secureStorageSvc.authenticate('unlock')).toEqual({
			authenticated: true,
			reason: 'unlock',
		});
		expect(transport.requests[0]).toMatchObject({
			service: 'secureStorage', op: 'authenticate', args: { reason: 'unlock' },
		});
	});

	test('capture.getSources filters by type; captureSource returns the frame', async () => {
		transport.pushReply({
			ok: true,
			value: [{ id: 1, label: 'Main', isMain: true, resolution: { width: 2560, height: 1440 } }],
		});
		const sources = await captureSvc.getSources({ types: ['display'] });
		expect(sources).toHaveLength(1);
		expect(transport.requests[0]).toMatchObject({
			service: 'capture', op: 'getSources', args: { types: ['display'] },
		});

		transport.pushReply({ ok: true, value: { width: 2560, height: 1440, pngBase64: 'aGk=' } });
		expect(await captureSvc.captureSource(1)).toEqual({
			width: 2560, height: 1440, pngBase64: 'aGk=',
		});
		expect(transport.requests[1]).toMatchObject({
			service: 'capture', op: 'captureSource', args: { id: 1 },
		});
	});

	test('menu.update/get/items op shapes', async () => {
		transport.pushReply({ ok: true, value: null });
		await menuSvc.update({ id: 'save', text: 'Save…', enabled: false, checked: true });
		expect(transport.requests[0]).toMatchObject({
			service: 'menu',
			op: 'update',
			args: { id: 'save', text: 'Save…', enabled: false, checked: true },
		});

		transport.pushReply({
			ok: true,
			value: { id: 'save', text: 'Save…', enabled: false, checked: true },
		});
		expect(await menuSvc.get('save')).toEqual({
			id: 'save', text: 'Save…', enabled: false, checked: true,
		});
		expect(transport.requests[1]).toMatchObject({ service: 'menu', op: 'get', args: { id: 'save' } });

		transport.pushReply({
			ok: true,
			value: [{ id: 'save', text: 'Save…', enabled: false, checked: true }],
		});
		expect(await menuSvc.items()).toEqual([
			{ id: 'save', text: 'Save…', enabled: false, checked: true },
		]);
		expect(transport.requests[2]).toMatchObject({ service: 'menu', op: 'items' });
	});
});

describe('bus once/Channel/allowlist', () => {
	test('oncePlatform unsubscribes after the first delivery', () => {
		const seen: unknown[] = [];
		oncePlatform('systemWake', (d) => seen.push(d));
		pushPlatformEvent('systemWake', {});
		pushPlatformEvent('systemWake', {});
		expect(seen).toEqual([{}]);
	});

	test('Channel routes channelMessage events to onmessage', async () => {
		const seen: number[] = [];
		const ch = new Channel<number>((v) => seen.push(v));
		pushPlatformEvent('channelMessage', { channel: `__channel__:${ch.id}`, value: 42 });
		pushPlatformEvent('channelMessage', { channel: String(ch.id), value: 7 });
		expect(seen).toEqual([42, 7]);

		// Channels serialize into call args via toJSON
		transport.pushReply({ ok: true, value: null });
		await callPlatform('capture', 'stream', { channel: ch });
		expect(transport.requests.at(-1)?.args.channel).toBe(`__channel__:${ch.id}`);

		ch.dispose();
		pushPlatformEvent('channelMessage', { channel: `__channel__:${ch.id}`, value: 9 });
		expect(seen).toEqual([42, 7]); // dropped after dispose
	});

	test('allowlist denies ops outside platform.allow', async () => {
		initPlatformForTests(transport, { allow: ['app.*', 'window.getTitle'] });

		transport.pushReply({ ok: true, value: 'probe' });
		expect(await appSvc.getName()).toBe('probe');
		transport.pushReply({ ok: true, value: 't' });
		expect(await windows.getTitle()).toBe('t');

		const caught = (await windows.setTitle('x').catch((e) => e)) as NativeApiError;
		expect(caught).toBeInstanceOf(NativeApiError);
		expect(caught.code).toBe('denied');
		expect(caught.message).toBe('window.setTitle is not in platform.allow');
		expect(transport.requests).toHaveLength(2); // denied call never hit the wire

		initPlatformForTests(transport); // reset without a list
		transport.pushReply({ ok: true, value: null });
		await windows.setTitle('x');
		expect(transport.requests).toHaveLength(3);
	});
});

describe('reactive namespaces — new events + members', () => {
	test('focusChanged/scaleFactorChanged feed window state', async () => {
		transport.serve('window', 'getBounds', {
			ok: true,
			value: { bounds: { x: 0, y: 0, width: 800, height: 600 }, state: 'normal' },
		});
		await window.init();

		pushPlatformEvent('focusChanged', { focused: true });
		expect(window.focused).toBe(true);
		pushPlatformEvent('focusChanged', { focused: false });
		expect(window.focused).toBe(false);

		pushPlatformEvent('scaleFactorChanged', { scaleFactor: 2 });
		expect(window.scaleFactor).toBe(2);
	});

	test('appActivated/appDeactivated feed app.active; secondInstance payload captured', async () => {
		await app.init();
		expect(app.active).toBe(true);
		pushPlatformEvent('appDeactivated', {});
		expect(app.active).toBe(false);
		pushPlatformEvent('appActivated', {});
		expect(app.active).toBe(true);

		pushPlatformEvent('secondInstance', { argv: ['/x', '--flag'], cwd: '/work' });
		expect(app.lastSecondInstance).toEqual({ argv: ['/x', '--flag'], cwd: '/work' });
	});

	test('trayClick feeds tray.lastRect', async () => {
		await tray.init();
		pushPlatformEvent('trayClick', { x: 10, y: 20, width: 24, height: 24 });
		expect(tray.lastRect).toEqual({ x: 10, y: 20, width: 24, height: 24 });
	});

	test('namespace .once() delivers a single event', async () => {
		const seen: boolean[] = [];
		window.once('focusChanged', (d: { focused: boolean }) => seen.push(d.focused));
		pushPlatformEvent('focusChanged', { focused: true });
		pushPlatformEvent('focusChanged', { focused: false });
		expect(seen).toEqual([true]);
	});

	test('window.onCloseRequested arms the veto; disarm drops it', async () => {
		transport.pushReply({ ok: true, value: { armed: true } });
		let fired = 0;
		const disarm = await window.onCloseRequested(() => { fired++; });
		expect(transport.requests.at(-1)).toMatchObject({
			service: 'window', op: 'setCloseVeto', args: { enabled: true },
		});

		pushPlatformEvent('willClose', {});
		expect(fired).toBe(1);

		transport.pushReply({ ok: true, value: { armed: false } });
		await disarm();
		expect(transport.requests.at(-1)).toMatchObject({
			service: 'window', op: 'setCloseVeto', args: { enabled: false },
		});

		pushPlatformEvent('willClose', {});
		expect(fired).toBe(1); // unsubscribed
	});

	test('namespace methods reach the new service ops', async () => {
		transport.pushReply({ ok: true, value: { status: 'granted' } });
		expect(await system.checkPermission('camera')).toEqual({ status: 'granted' });

		transport.pushReply({ ok: true, value: null });
		await menu.update({ id: 'm1', enabled: false });
		expect(transport.requests.at(-1)).toMatchObject({ service: 'menu', op: 'update' });

		transport.pushReply({ ok: true, value: { width: 10, height: 10, pngBase64: 'eA==' } });
		expect(await capture.captureSource(4)).toEqual({ width: 10, height: 10, pngBase64: 'eA==' });
	});
});

describe('store namespace (persisted JSON KV)', () => {
	test('init loads the file; set/flush persists; load() reads back', async () => {
		const dir = mkdtempSync('/tmp/store-test-');
		try {
			transport.serve('app', 'getPath', { ok: true, value: dir });
			await store.init();
			expect(store.ready).toBe(true);
			expect(store.path).toBe(`${dir}/svelte-desktop-store.json`);
			expect(store.get('theme')).toBeUndefined();

			store.set('theme', 'dark');
			expect(store.data.theme).toBe('dark');
			await store.flush();
			expect(existsSync(`${dir}/svelte-desktop-store.json`)).toBe(true);
			const written = JSON.parse(readFileSync(`${dir}/svelte-desktop-store.json`, 'utf8'));
			expect(written.theme).toBe('dark');

			store.clear();
			expect(store.data).toEqual({});
			await store.load();
			expect(store.get('theme')).toBe('dark');
		} finally {
			store.clear();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('delete removes a key; debounced auto-save writes without flush()', async () => {
		const dir = mkdtempSync('/tmp/store-test-');
		try {
			transport.serve('app', 'getPath', { ok: true, value: dir });
			await store.init();
			store.set('a', 1);
			store.set('b', 2);
			store.delete('a');
			expect(store.get('a')).toBeUndefined();
			expect(store.get('b')).toBe(2);
			await new Promise((r) => setTimeout(r, 300)); // debounce window
			const written = JSON.parse(readFileSync(`${dir}/svelte-desktop-store.json`, 'utf8'));
			expect(written).toEqual({ b: 2 });
		} finally {
			store.clear();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('events namespace (pure JS)', () => {
	test('on/emit/once dispatch locally', () => {
		const seen: unknown[] = [];
		events.on('tick', (d: unknown) => seen.push((d as { n: number }).n));
		events.emit('tick', { n: 1 });
		events.once('tick', () => seen.push('once'));
		events.emit('tick', { n: 2 }); // on fires (insertion order), then once — then once detaches
		events.emit('tick', { n: 3 });
		expect(seen).toEqual([1, 2, 'once', 3]);
	});

	test('emitTo routes to main, rejects other window ids', async () => {
		const seen: unknown[] = [];
		events.on('msg', (d: unknown) => seen.push(d));
		await events.emitTo('main', 'msg', { hi: true });
		expect(seen).toEqual([{ hi: true }]);

		const caught = (await events.emitTo('settings', 'msg', {}).catch((e) => e)) as NativeApiError;
		expect(caught).toBeInstanceOf(NativeApiError);
		expect(caught.code).toBe('invalid_args');
	});
});

describe('dpi conversions', () => {
	test('logical ↔ physical positions and sizes', () => {
		const lp = new LogicalPosition(10, 20);
		const pp = lp.toPhysical(2);
		expect(pp).toBeInstanceOf(PhysicalPosition);
		expect(pp.x).toBe(20);
		expect(pp.y).toBe(40);
		expect(pp.toLogical(2)).toEqual(lp);
		expect(lp.toLogical(2)).toBe(lp); // identity conversion

		const ls = new LogicalSize(100, 50);
		const ps = ls.toPhysical(1.5);
		expect(ps).toBeInstanceOf(PhysicalSize);
		expect(ps.width).toBe(150);
		expect(ps.height).toBe(75);
		expect(ps.toLogical(1.5).width).toBe(100);
		expect(ps.toPhysical(2)).toBe(ps); // identity conversion
	});

	test('toJSON emits plain shapes for call args', () => {
		expect(new LogicalPosition(1, 2).toJSON()).toEqual({ x: 1, y: 2 });
		expect(JSON.parse(JSON.stringify({ p: new PhysicalSize(3, 4) }))).toEqual({
			p: { width: 3, height: 4 },
		});
	});
});

describe('await-using handles', () => {
	test('shortcuts.acquire dispose unregisters', async () => {
		transport.pushReply({ ok: true, value: { id: 's-9' } });
		const reg = await shortcutsSvc.acquire({ accelerator: 'CmdOrCtrl+K', id: 'palette' });
		expect(reg.id).toBe('s-9');
		expect(transport.requests[0]).toMatchObject({ service: 'shortcuts', op: 'register' });

		transport.pushReply({ ok: true, value: null });
		await reg[Symbol.asyncDispose]();
		expect(transport.requests.at(-1)).toMatchObject({
			service: 'shortcuts', op: 'unregister', args: { id: 's-9' },
		});
	});

	test('power.acquireSleepBlocker dispose unblocks', async () => {
		transport.pushReply({ ok: true, value: { id: 11 } });
		const blocker = await powerSvc.acquireSleepBlocker({ type: 'display', reason: 'export' });
		expect(blocker.id).toBe(11);
		expect(transport.requests[0]).toMatchObject({
			service: 'power', op: 'blockSleep', args: { type: 'display', reason: 'export' },
		});

		transport.pushReply({ ok: true, value: null });
		await blocker[Symbol.asyncDispose]();
		expect(transport.requests.at(-1)).toMatchObject({
			service: 'power', op: 'unblockSleep', args: { id: 11 },
		});
	});

	test('tray.acquire sets then removes on dispose', async () => {
		transport.pushReply({ ok: true, value: { set: true } });
		const handle = await traySvc.acquire({ title: 'h' });
		expect(transport.requests[0]).toMatchObject({
			service: 'tray', op: 'set', args: { title: 'h' },
		});

		transport.pushReply({ ok: true, value: null });
		await handle[Symbol.asyncDispose]();
		expect(transport.requests.at(-1)).toMatchObject({ service: 'tray', op: 'remove' });
	});

	test('await using syntax disposes at scope exit', async () => {
		transport.pushReply({ ok: true, value: { id: 's-1' } });
		{
			await using reg = await shortcutsSvc.acquire({ accelerator: 'CmdOrCtrl+L' });
			expect(reg.id).toBe('s-1');
			transport.pushReply({ ok: true, value: null });
		}
		expect(transport.requests.at(-1)).toMatchObject({ service: 'shortcuts', op: 'unregister' });
	});
});

describe('windowState flags', () => {
	test('save({flags}) records the subset; restore({flags}) applies only those', async () => {
		const dir = mkdtempSync('/tmp/wstate-flags-');
		try {
			transport.pushReply({
				ok: true,
				value: { bounds: { x: 5, y: 6, width: 1024, height: 768 }, state: 'maximized' },
			}); // getBounds
			transport.pushReply({ ok: true, value: dir }); // getPath
			const saved = await windowState.save({ flags: ['size'] });
			expect(saved.flags).toEqual(['size']);
			expect(saved.state).toBeUndefined(); // maximized not flagged → not captured
			expect(saved.bounds.width).toBe(1024);

			// restore applies only 'size' — no setPosition op goes out
			transport.pushReply({ ok: true, value: dir }); // getPath for load
			const before = transport.requests.length;
			transport.pushReply({ ok: true, value: null });
			const restored = await windowState.restore({ flags: ['size'] });
			expect(restored?.bounds.width).toBe(1024);
			const ops = transport.requests
				.slice(before)
				.filter((r) => r.service === 'window')
				.map((r) => r.op);
			expect(ops).toEqual(['setSize']);
			expect(ops).not.toContain('setPosition');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('restore defaults to all aspects incl. maximized/visible', async () => {
		const dir = mkdtempSync('/tmp/wstate-flags-');
		try {
			transport.serve('app', 'getPath', { ok: true, value: dir });
			// Seed a snapshot with every aspect captured
			transport.pushReply({
				ok: true,
				value: { bounds: { x: 1, y: 2, width: 640, height: 480 }, state: 'fullscreen' },
			});
			// isMinimized unserved → default null reply → visible falls back to true
			const saved = await windowState.save();
			expect(saved.state).toBe('fullscreen');
			expect(saved.visible).toBe(true);

			const before = transport.requests.length;
			transport.serve('window', 'setPosition', { ok: true, value: null });
			transport.serve('window', 'setSize', { ok: true, value: null });
			transport.serve('window', 'setFullscreen', { ok: true, value: { fullscreen: true } });
			transport.serve('window', 'show', { ok: true, value: null });
			await windowState.restore();
			const ops = transport.requests.slice(before).map((r) => r.op);
			expect(ops).toContain('setPosition');
			expect(ops).toContain('setSize');
			expect(ops).toContain('setFullscreen');
			expect(ops).toContain('show');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('multi-window ops (M3)', () => {
	test('windows.create sends the create envelope and resolves {windowId,label}', async () => {
		transport.pushReply({ ok: true, value: { windowId: 1, label: 'settings' } });
		const res = await windows.create({
			label: 'settings',
			title: 'Settings',
			width: 640,
			height: 480,
			alwaysOnTop: true,
		});
		expect(res).toEqual({ windowId: 1, label: 'settings' });
		expect(transport.requests[0]).toMatchObject({
			service: 'window',
			op: 'create',
			args: { label: 'settings', title: 'Settings', width: 640, height: 480, alwaysOnTop: true },
		});
	});

	test('windows.create propagates invalid_args (duplicate label)', async () => {
		transport.pushReply({
			ok: false,
			error: { code: 'invalid_args', message: "duplicate window label 'main'" },
		});
		const caught = (await windows.create({ label: 'main' }).catch((e) => e)) as NativeApiError;
		expect(caught).toBeInstanceOf(NativeApiError);
		expect(caught.code).toBe('invalid_args');
	});

	test('windows.list/focus/get envelopes', async () => {
		transport.pushReply({
			ok: true,
			value: [
				{ windowId: 0, label: 'main', focused: true, bounds: { x: 0, y: 0, width: 800, height: 600 } },
				{ windowId: 1, label: 'settings', focused: false, bounds: { x: 40, y: 40, width: 640, height: 480 } },
			],
		});
		const list = await windows.list();
		expect(list).toHaveLength(2);
		expect(list[1]).toMatchObject({ windowId: 1, label: 'settings', focused: false });
		expect(transport.requests[0]).toMatchObject({ service: 'window', op: 'list' });

		transport.pushReply({ ok: true, value: null });
		await windows.focus(1);
		expect(transport.requests[1]).toMatchObject({
			service: 'window',
			op: 'focus',
			args: { windowId: 1 },
		});

		transport.pushReply({
			ok: true,
			value: { windowId: 1, label: 'settings', focused: true, bounds: { x: 40, y: 40, width: 640, height: 480 } },
		});
		expect(await windows.get('settings')).toMatchObject({ windowId: 1, label: 'settings' });
		expect(transport.requests[2]).toMatchObject({
			service: 'window',
			op: 'get',
			args: { label: 'settings' },
		});

		// unknown label → null, not a rejection
		transport.pushReply({ ok: true, value: null });
		expect(await windows.get('nope')).toBe(null);
	});

	test('windows.close: absent windowId keeps legacy args, explicit sends it', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.close();
		expect(transport.requests[0]).toMatchObject({ service: 'window', op: 'close', args: {} });

		transport.pushReply({ ok: true, value: null });
		await windows.close(1);
		expect(transport.requests[1]).toMatchObject({
			service: 'window',
			op: 'close',
			args: { windowId: 1 },
		});
	});

	test('windowId passthrough on existing window ops', async () => {
		transport.pushReply({ ok: true, value: null });
		await windows.setSize(800, 600, 2);
		expect(transport.requests[0]).toMatchObject({
			service: 'window',
			op: 'setSize',
			args: { width: 800, height: 600, windowId: 2 },
		});

		transport.pushReply({ ok: true, value: null });
		await windows.minimize(2);
		expect(transport.requests[1]).toMatchObject({
			service: 'window',
			op: 'minimize',
			args: { windowId: 2 },
		});

		// absent → no windowId key on the wire (dispatching view → 0)
		transport.pushReply({ ok: true, value: 't' });
		await windows.getTitle();
		expect(transport.requests[2]).toMatchObject({ service: 'window', op: 'getTitle', args: {} });
		expect('windowId' in (transport.requests[2]?.args ?? {})).toBe(false);

		transport.pushReply({ ok: true, value: null });
		await windows.setBounds(1, 2, 300, 200, 5);
		expect(transport.requests[3]).toMatchObject({
			service: 'window',
			op: 'setBounds',
			args: { x: 1, y: 2, width: 300, height: 200, windowId: 5 },
		});

		// setEdited alias forwards windowId through to setDocumentEdited
		transport.pushReply({ ok: true, value: null });
		await windows.setEdited(true, 3);
		expect(transport.requests[4]).toMatchObject({
			service: 'window',
			op: 'setDocumentEdited',
			args: { edited: true, windowId: 3 },
		});
	});
});

describe('emitTo/onWindow window-scoped events', () => {
	test('emitTo delivers {windowId, ...payload}; onWindow filters by id', () => {
		const seen2: unknown[] = [];
		const off2 = onWindow(2, 'msg', (d) => seen2.push(d));
		const seen3: unknown[] = [];
		onWindow(3, 'msg', (d) => seen3.push(d));

		emitTo(2, 'msg', { hi: true });
		emitTo(3, 'msg', { hi: false });
		expect(seen2).toEqual([{ hi: true, windowId: 2 }]);
		expect(seen3).toEqual([{ hi: false, windowId: 3 }]);

		off2();
		emitTo(2, 'msg', { again: 1 });
		expect(seen2).toHaveLength(1); // unsubscribe works
	});

	test('onWindow filters real platform events carrying windowId', () => {
		const seen: unknown[] = [];
		onWindow(4, 'focusChanged', (d) => seen.push(d));
		pushPlatformEvent('focusChanged', { focused: true, windowId: 4 });
		pushPlatformEvent('focusChanged', { focused: true, windowId: 5 });
		pushPlatformEvent('focusChanged', { focused: true }); // no windowId → skipped
		expect(seen).toEqual([{ focused: true, windowId: 4 }]);
	});

	test('emitTo payload shapes: absent / primitive payloads', () => {
		const seen: unknown[] = [];
		onWindow(1, 'tick', (d) => seen.push(d));
		emitTo(1, 'tick');
		emitTo(1, 'tick', 'ping');
		expect(seen).toEqual([{ windowId: 1 }, { windowId: 1, data: 'ping' }]);
	});

	test('emitTo events reach plain onPlatform subscribers too', () => {
		const seen: unknown[] = [];
		const off = onPlatform('custom', (d) => seen.push(d));
		emitTo(7, 'custom', { a: 1 });
		expect(seen).toEqual([{ a: 1, windowId: 7 }]);
		off();
	});
});
