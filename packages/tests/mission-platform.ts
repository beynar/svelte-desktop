/**
 * Mission probe — runtime-test the brokered platform API against the live
 * GPUI renderer. Opens a real window, runs typed calls through
 * `renderer.platformCall`, records every result to results/<run>/platform.jsonl.
 *
 * Skipped by design: dialog.show* (modal UI would block the probe) and
 * shell.openExternal positive paths (real external side effects). Both are
 * covered by capabilities.describe plus negative-path probes below.
 */
import { GpuixRenderer } from '@gpuix/native';
import { appendFileSync, mkdirSync } from 'fs';
import { installGlobals, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer } from '@svelte-desktop/gpuix/native';
import { initPlatform } from '@svelte-desktop/platform';
import {
	app, windows, screen, clipboard, shell, theme, system, power,
	secureStorage, notifications, deepLink, menu, capture, diagnostics,
	capabilities, tray, shortcuts, onAnyPlatform,
} from '@svelte-desktop/platform';
import { windowState } from '@svelte-desktop/platform/windowState';
// svelte-desktop/stores → gen/native-api/stores.js — rune-compiled reactive API
import * as sd from 'svelte-desktop/stores';

const RUN = `run-${new Date().toISOString().slice(0, 10)}-platform`;
const DIR = new URL(`../../results/${RUN}/`, import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });
const OUT = `${DIR}platform.jsonl`;
appendFileSync(OUT, ''); // create if missing
const rec = (o: object) => appendFileSync(OUT, JSON.stringify({ ts: Date.now(), ...o }) + '\n');
Bun.write(OUT, ''); // truncate — every run starts a fresh ledger

const probe = async (name: string, fn: () => Promise<unknown> | unknown) => {
	const timeout = new Promise<never>((_r, reject) =>
		setTimeout(() => reject(Object.assign(new Error('probe timed out'), { code: 'timeout' })), 15_000),
	);
	try {
		const v = await Promise.race([Promise.resolve().then(fn), timeout]);
		console.log(`ok   ${name}:`, JSON.stringify(v)?.slice(0, 220));
		rec({ probe: name, ok: true, result: v ?? null });
	} catch (e) {
		const err = e as Error & { code?: string };
		console.log(`fail ${name}: [${err.code ?? 'ERR'}] ${err.message}`);
		rec({ probe: name, ok: false, code: err.code ?? null, error: err.message });
	}
};

/** A probe expected to reject — the error *is* the contract under test. */
const probeDenied = async (name: string, expectedCode: string, fn: () => Promise<unknown> | unknown) => {
	try {
		const v = await fn();
		console.log(`fail ${name}: expected ${expectedCode}, got success:`, JSON.stringify(v)?.slice(0, 120));
		rec({ probe: name, ok: false, expected: expectedCode, unexpectedSuccess: v ?? null });
	} catch (e) {
		const err = e as Error & { code?: string };
		const matched = err.code === expectedCode;
		console.log(`${matched ? 'ok  ' : 'fail'} ${name}: [${err.code}] ${err.message}`);
		rec({ probe: name, ok: matched, expected: expectedCode, code: err.code ?? null, error: err.message });
	}
};

installGlobals();
const renderer = new GpuixRenderer((_err, payload) => {
	dispatchPayload(payload);
});
setRenderer(renderer);
renderer.init({ title: 'gpuix platform probe', width: 520, height: 400 });
initPlatform(renderer);

// Platform-event tap: records every event the sink delivers during the probe.
const seenEvents: string[] = [];
onAnyPlatform((event, data) => {
	seenEvents.push(event);
	rec({ platformEvent: event, data });
});

// Persistent tick loop: pending ops (credentials, capture sources, URL
// schemes) resolve on the GPUI executor — it only advances while tick() runs.
const ticker = setInterval(() => renderer.tick(), 4);
const pump = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await pump(120);

console.log('platform probe — capabilities first, then live calls');

await probe('capabilities.describe', () => capabilities.describe());
await probe('diagnostics.info', () => diagnostics.info());

// ── app ──
await probe('app.whenReady', () => app.whenReady());
await probe('app.getInfo', () => app.getInfo());
await probe('app.getName', () => app.getName());
await probe('app.getVersion', () => app.getVersion());
await probe('app.getPath(userData)', () => app.getPath('userData'));
await probe('app.getPath(temp)', () => app.getPath('temp'));
await probe('app.getPath(desktop)', () => app.getPath('desktop'));
await probeDenied('app.getPath(bogus)', 'invalid_args', () => app.getPath('bogus' as never));
await probe('app.addRecentDocument', () => app.addRecentDocument('/tmp/gpuix-probe.txt'));

// ── window ──
await probe('windows.getSize', () => windows.getSize());
await probe('windows.getBounds', () => windows.getBounds());
await probe('windows.getTitle', () => windows.getTitle());
await probe('windows.setTitle', () => windows.setTitle('probe title'));
await probe('windows.getTitle(after set)', () => windows.getTitle());
await probe('windows.getScaleFactor', () => windows.getScaleFactor());
await probe('windows.isFocused', () => windows.isFocused());
await probe('windows.isMaximized', () => windows.isMaximized());
await probe('windows.isFullscreen', () => windows.isFullscreen());
await probe('windows.getCursorPoint', () => windows.getCursorPoint());
await probe('windows.getPosition→setPosition→restore', async () => {
	const before = await windows.getPosition();
	await windows.setPosition(before.x + 40, before.y + 40);
	await pump(150);
	const moved = await windows.getPosition();
	await windows.setPosition(before.x, before.y);
	await pump(150);
	const restored = await windows.getPosition();
	return { before, moved, restored };
});
await probe('windows.setSize', async () => {
	await windows.setSize(560, 420);
	await pump(80); // resize applies on the next frame
	return windows.getSize();
});
await probe('windows.fullscreen roundtrip', async () => {
	await windows.setFullscreen(true);
	await pump(700);
	const on = await windows.isFullscreen();
	await windows.setFullscreen(false);
	await pump(700);
	const off = await windows.isFullscreen();
	return { on, off };
});
await probe('windows.setRepresentedFilename', () =>
	windows.setRepresentedFilename('/tmp/gpuix-probe.txt'));

// ── screen ──
await probe('screen.getAllDisplays', () => screen.getAllDisplays());
await probe('screen.getPrimaryDisplay', () => screen.getPrimaryDisplay());
await probe('screen.getDisplayNearestWindow', () => screen.getDisplayNearestWindow());
await probe('screen.getCursorScreenPoint', () => screen.getCursorScreenPoint());
await probe('screen.scaleFactor', () => screen.scaleFactor());

// ── clipboard ──
await probe('clipboard roundtrip', async () => {
	await clipboard.writeText('platform-probe-clip');
	const text = await clipboard.readText();
	const formats = await clipboard.availableFormats();
	return { text, formats };
});
await probe('clipboard.has(text/plain)', () => clipboard.has('text/plain'));
await probe('clipboard.clear+read', async () => {
	await clipboard.clear();
	return clipboard.readText();
});

// ── theme (also exercises the appearanceChanged event path) ──
await probe('theme.get', () => theme.get());
await probe('theme.shouldUseDarkColors', () => theme.shouldUseDarkColors());
await probe('theme.set(opposite)→get→restore', async () => {
	const before = await theme.get();
	const flipped = before.dark ? 'light' : 'dark';
	await theme.set(flipped);
	await pump(80);
	const during = await theme.get();
	await theme.set('system'); // restore to following the OS — the least surprising default
	await pump(80);
	return { before: before.appearance, during: during.appearance };
});

// ── reactive namespaces (svelte-desktop/stores, rune-compiled) ──
await probe('initStores() — every namespace ready or error-captured', async () => {
	const stores = await sd.initStores();
	const bad = stores.filter((s) => s.error);
	const notReady = stores.filter((s) => !s.ready);
	return {
		total: stores.length,
		errors: bad.map((s) => s.error?.message),
		notReady: notReady.length,
		appName: sd.app.name,
		windowTitle: sd.window.title,
		displays: sd.screen.displayCount,
		clip: sd.clipboard.text,
		theme: sd.theme.name,
		layout: sd.system.layout,
		thermal: sd.power.thermal,
		pid: sd.diagnostics.pid,
		services: Object.keys(sd.capabilities.report?.services ?? {}).length,
		persisted: sd.windowState.persisted,
	};
});
await probe('theme event-driven $state (raw set → event → store)', async () => {
	const before = sd.theme.current?.appearance;
	await theme.set(sd.theme.dark ? 'light' : 'dark'); // raw service — store updates only via appearanceChanged
	await pump(80);
	const eventDriven = sd.theme.current?.appearance;
	await sd.theme.set('system');
	return { before, eventDriven, dark: sd.theme.dark };
});
await probe('windowState save → persisted $state', async () => {
	const saved = await sd.windowState.save();
	return { persisted: sd.windowState.persisted, saved };
});

// ── system / power ──
await probe('system.info', () => system.info());
await probe('system.getKeyboardLayout', () => system.getKeyboardLayout());
await probe('power.getThermalState', () => power.getThermalState());
await probe('power.getSystemIdleTime', () => power.getSystemIdleTime());

// ── gap work: power/session ──
await probe('power.getBattery', () => power.getBattery());
await probe('power.blockSleep→unblockSleep', async () => {
	const { id } = await power.blockSleep({ type: 'idle', reason: 'gpuix probe' });
	await power.unblockSleep(id);
	return { id };
});
await probeDenied('power.blockSleep(bogus type)', 'invalid_args', () =>
	power.blockSleep({ type: 'bogus' as never }));

// ── gap work: app extras ──
await probe('app.setDockBadge→clear', async () => {
	await app.setDockBadge('42');
	const cleared = await app.setDockBadge(null);
	return cleared;
});
await probe('app.bounceDock(informational)', () => app.bounceDock('informational'));
await probe('app.setActivationPolicy (unbundled binary may refuse — honest either way)', async () => {
	try {
		return await app.setActivationPolicy('regular');
	} catch (e) {
		return { error: (e as Error & { code?: string }).code ?? 'ERR' };
	}
});
await probe('app.requestSingleInstanceLock', () => app.requestSingleInstanceLock());
await probe('app.setLoginItem (dev binary — honest either way)', async () => {
	try {
		return await app.setLoginItem(true);
	} catch (e) {
		return { error: (e as Error & { code?: string }).code ?? 'ERR' };
	}
});

// ── gap work: system reads ──
await probe('system.getAccentColor', () => system.getAccentColor());
await probe('system.getAccessibility', () => system.getAccessibility());

// ── gap work: clipboard rich formats ──
await probe('clipboard html roundtrip', async () => {
	await clipboard.writeHtml('<b>gpuix-probe</b>');
	const html = await clipboard.readHtml();
	const formats = await clipboard.availableFormats();
	return { html, formats };
});
await probe('clipboard rtf roundtrip', async () => {
	await clipboard.writeRtf('{\\rtf1 gpuix-probe}');
	const rtf = await clipboard.readRtf();
	await clipboard.clear();
	return { rtf };
});

// ── gap work: tray + shortcuts ──
await probe('tray.set→remove', async () => {
	await tray.set({ title: 'GPUIX', tooltip: 'gpuix platform probe' });
	await pump(120);
	await tray.remove();
	return { done: true };
});
await probe('shortcuts.register→unregister', async () => {
	const { id } = await shortcuts.register({ accelerator: 'CmdOrCtrl+Shift+9' });
	await shortcuts.unregister({ id });
	return { id };
});
await probeDenied('shortcuts.register(bogus key)', 'invalid_args', () =>
	shortcuts.register({ accelerator: 'CmdOrCtrl+DefinitelyNotAKey' }));

// ── gap work: shell extras ──
await probe('shell.beep', () => shell.beep());
await probe('shell.trashItem', async () => {
	await Bun.write('/tmp/gpuix-probe-trash.txt', 'probe');
	await shell.trashItem('/tmp/gpuix-probe-trash.txt');
	return { trashed: !(await Bun.file('/tmp/gpuix-probe-trash.txt').exists()) };
});
// menu.popup: skipped — menu tracking blocks like modal dialogs
rec({ probe: 'menu.popup', ok: null, note: 'skipped — menu tracking blocks automation; capability-checked' });

// ── setLoginItem: ServiceManagement is now dlopen'd — unbundled binary
// reaches the bundle-identity guard (unavailable), not a missing class ──
await probeDenied('app.setLoginItem(unbundled)', 'unavailable', () =>
	app.setLoginItem(true));

// ── secureStorage (Keychain; pending→platformResult path) ──
await probe('secureStorage roundtrip', async () => {
	await secureStorage.setPassword('gpuix-probe', 'probe-account', 's3cret-probe');
	const read = await secureStorage.getPassword('gpuix-probe', 'probe-account');
	await secureStorage.deletePassword('gpuix-probe', 'probe-account');
	const after = await secureStorage.getPassword('gpuix-probe', 'probe-account');
	return { read, after };
});
await probe('secureStorage.getPassword(missing)', () =>
	secureStorage.getPassword('gpuix-probe', 'never-written'));

// ── notifications ──
await probe('notifications.show', () =>
	notifications.show({ title: 'gpuix probe', body: 'platform API live', tag: 'probe' }));
await probe('notifications.dismiss', () => notifications.dismiss('probe'));

// ── deepLink (unbundled binary → GPUI refuses; bundled apps succeed) ──
await probeDenied('deepLink.register(gpuixprobe)', 'unavailable', () =>
	deepLink.register('gpuixprobe'));

// ── menu ──
await probe('menu.setAppMenu', () =>
	menu.setAppMenu([
		{
			name: 'Probe',
			items: [
				{ type: 'action', id: 'probe.ping', label: 'Ping' },
				{ type: 'separator' },
				{ type: 'action', id: 'probe.disabled', label: 'Disabled', disabled: true },
			],
		},
	]));
await probe('menu.setDockMenu', () =>
	menu.setDockMenu([{ type: 'action', id: 'probe.dock', label: 'Dock Ping' }]));

// ── capture (gpui built without the feature → honest unavailable) ──
await probe('capture.isSupported', () => capture.isSupported());
await probeDenied('capture.getSources', 'unavailable', () => capture.getSources());

// ── shell (negative paths only — no real external side effects) ──
await probeDenied('shell.openExternal(javascript:)', 'denied', () =>
	shell.openExternal('javascript:alert(1)'));
await probeDenied('shell.openExternal(notaurl)', 'invalid_args', () =>
	shell.openExternal('notaurl'));
await probeDenied('shell.openPath(missing)', 'unavailable', () =>
	shell.openPath('/nonexistent/gpuix-probe-path'));

// ── phase 2: window chrome depth (every mutating probe restores) ──
const home = await windows.getPosition();
await probe('windows.innerSize/outerSize/innerPosition/outerPosition', async () => ({
	inner: await windows.innerSize(),
	outer: await windows.outerSize(),
	innerPos: await windows.innerPosition(),
	outerPos: await windows.outerPosition(),
}));
await probe('windows.setBounds→restore', async () => {
	await windows.setBounds(home.x + 30, home.y + 30, 500, 380);
	await pump(150);
	const moved = await windows.getBounds();
	await windows.setBounds(home.x, home.y, 520, 400);
	await pump(150);
	return { moved, restored: await windows.getBounds() };
});
await probe('windows.center→restore', async () => {
	await windows.center();
	await pump(120);
	const centered = await windows.getPosition();
	await windows.setPosition(home.x, home.y);
	return { centered };
});
await probe('windows.positionTo(cursorTopLeft)→restore', async () => {
	await windows.positionTo('cursorTopLeft');
	await pump(120);
	const at = await windows.getPosition();
	await windows.setPosition(home.x, home.y);
	return { at };
});

// ── FFI review fixes: non-finite geometry must reject before AppKit ──
// (1e999 survives JSON as a literal and parses to +inf; bare Infinity/NaN
// serialize to null — both must land invalid_args, never reach setFrame:)
await probeDenied('windows.setBounds(1e999 x)', 'invalid_args', () =>
	windows.setBounds(1e999, home.y, 520, 400));
await probeDenied('windows.setBounds(NaN h)', 'invalid_args', () =>
	windows.setBounds(home.x, home.y, 520, Number.NaN));
await probeDenied('windows.setPosition(-1e999)', 'invalid_args', () =>
	windows.setPosition(-1e999, home.y));
// Optional numeric args degrade to absent when the wire drops the value —
// consistent with opt_str/opt_bool; it never reaches AppKit either way.
await probe('app.setDockProgress(1e999→absent)', () =>
	app.setDockProgress({ status: 'normal', total: 1e999 }));
await probeDenied('windows.setOpacity(1e999)', 'invalid_args', () =>
	windows.setOpacity(1e999));
await probe('windows.positionTo(center)', () => windows.positionTo('center').then(async () => {
	const at = await windows.getPosition();
	await windows.setPosition(home.x, home.y);
	return at;
}));
await probeDenied('windows.positionTo(bogus)', 'invalid_args', () =>
	windows.positionTo('bogus' as never));
await probe('windows.minimize→unminimize', async () => {
	await windows.minimize();
	await pump(400);
	const min = await windows.isMinimized();
	await windows.unminimize();
	await pump(400);
	return { min, restored: !(await windows.isMinimized()) };
});
await probe('windows.toggleMaximize→restore', async () => {
	await windows.toggleMaximize();
	await pump(300);
	const zoomed = await windows.isMaximized();
	await windows.toggleMaximize();
	await pump(300);
	return { zoomed, restored: !(await windows.isMaximized()) };
});
await probe('windows.setAlwaysOnTop→off', async () => {
	await windows.setAlwaysOnTop(true);
	await windows.setAlwaysOnTop(false);
	return 'ok';
});
await probe('windows.setAlwaysOnBottom→off', async () => {
	await windows.setAlwaysOnBottom(true);
	await windows.setAlwaysOnBottom(false);
	return 'ok';
});
await probe('windows.blur→focus', async () => {
	await windows.blur();
	await pump(150);
	const active = await windows.isActive();
	await windows.focus();
	await pump(150);
	return { duringBlur: active, refocused: await windows.isActive() };
});
await probe('windows.isHovered/isActive', async () => ({
	hovered: await windows.isHovered(),
	active: await windows.isActive(),
}));
await probe('windows chrome flags roundtrips', async () => {
	await windows.setResizable(false);
	const r = await windows.isResizable();
	await windows.setResizable(true);
	await windows.setClosable(false);
	const c = await windows.isClosable();
	await windows.setClosable(true);
	await windows.setMinimizable(false);
	const mn = await windows.isMinimizable();
	await windows.setMinimizable(true);
	await windows.setMaximizable(false);
	const mx = await windows.isMaximizable();
	await windows.setMaximizable(true);
	return { resizableOff: r, closableOff: c, minimizableOff: mn, maximizableOff: mx };
});
await probe('windows.setTitleBarStyle(transparent→hidden→default)', async () => {
	await windows.setTitleBarStyle('transparent');
	await pump(80);
	await windows.setTitleBarStyle('hidden');
	await pump(80);
	await windows.setTitleBarStyle('default');
	await pump(80);
	return 'ok';
});
await probe('windows.setDecorations→restore', async () => {
	await windows.setDecorations(false);
	await pump(150);
	await windows.setDecorations(true);
	await pump(150);
	return 'ok';
});
await probe('windows.setOpacity→1', async () => {
	await windows.setOpacity(0.7);
	const dim = await windows.getOpacity();
	await windows.setOpacity(1);
	return { dim, restored: await windows.getOpacity() };
});
await probe('windows.setIgnoresMouseEvents→off', async () => {
	await windows.setIgnoresMouseEvents(true);
	const on = await windows.ignoresMouseEvents();
	await windows.setIgnoresMouseEvents(false);
	return { on, off: !(await windows.ignoresMouseEvents()) };
});
await probe('windows.setContentProtected→off', async () => {
	await windows.setContentProtected(true);
	const on = await windows.isContentProtected();
	await windows.setContentProtected(false);
	return { on, off: !(await windows.isContentProtected()) };
});
await probe('windows.setVisibleOnAllWorkspaces→off', async () => {
	await windows.setVisibleOnAllWorkspaces(true);
	await windows.setVisibleOnAllWorkspaces(false);
	return 'ok';
});
await probe('windows.setDocumentEdited→clear', async () => {
	await windows.setDocumentEdited(true);
	const edited = await windows.isDocumentEdited();
	await windows.setDocumentEdited(false);
	return { edited, cleared: !(await windows.isDocumentEdited()) };
});
await probe('windows.setMinSize/setMaxSize→clear', async () => {
	await windows.setMinSize(300, 300);
	await windows.setMaxSize(800, 600);
	await windows.setMinSize(0, 0);
	await windows.setMaxSize(0, 0);
	return 'ok';
});
await probe('windows.setHasShadow+invalidateShadow', async () => {
	await windows.setHasShadow(false);
	await windows.invalidateShadow();
	await windows.setHasShadow(true);
	await windows.invalidateShadow();
	return 'ok';
});
await probe('windows.setMovable/ByWindowBackground→restore', async () => {
	await windows.setMovable(false);
	await windows.setMovableByWindowBackground(false);
	await windows.setMovable(true);
	await windows.setMovableByWindowBackground(true);
	return 'ok';
});
await probe('windows.setCursorPosition→restore', async () => {
	const before = await screen.getCursorScreenPoint();
	await windows.setCursorPosition(before.x + 5, before.y + 5);
	const warped = await screen.getCursorScreenPoint();
	await windows.setCursorPosition(before.x, before.y);
	return { before, warped };
});
await probe('windows.setCursorHidden→show', async () => {
	await windows.setCursorHidden(true);
	await windows.setCursorHidden(false);
	return 'ok';
});
await probe('windows.setTheme(dark→system)', async () => {
	await windows.setTheme('dark');
	await pump(80);
	await windows.setTheme('system');
	return 'ok';
});
await probeDenied('windows.setFocusable', 'unsupported', () =>
	windows.setFocusable(true));
await probe('windows.setSimpleFullscreen→off', async () => {
	await windows.setSimpleFullscreen(true);
	await pump(400);
	const on = await windows.isSimpleFullscreen();
	await windows.setSimpleFullscreen(false);
	await pump(400);
	return { on, off: !(await windows.isSimpleFullscreen()) };
});

// ── phase 2: app extras ──
await probe('app.setDockProgress→none', async () => {
	await app.setDockProgress({ status: 'normal', completed: 40, total: 100 });
	await pump(120);
	await app.setDockProgress({ status: 'paused', completed: 60, total: 100 });
	await pump(120);
	await app.setDockProgress({ status: 'none' });
	return 'ok';
});
await probe('app.getBundleType', () => app.getBundleType());
await probe('app.defaultWindowIcon (dev binary — honest either way)', () =>
	app.defaultWindowIcon());
// app.aboutPanel — non-modal About panel; opens and dies with the probe app.
await probe('app.aboutPanel', () =>
	app.aboutPanel({ name: 'gpuix probe', version: '0.0' }));

// ── phase 2: permissions (reads only — requests can show OS prompts) ──
for (const name of ['accessibility', 'screenRecording', 'fullDiskAccess', 'camera', 'microphone'] as const) {
	await probe(`system.checkPermission(${name})`, () => system.checkPermission(name));
}
// notifications needs a bundle identity — unbundled probe gets `unavailable`.
await probeDenied('system.checkPermission(notifications)', 'unavailable', () =>
	system.checkPermission('notifications'));
await probeDenied('system.requestPermission(fullDiskAccess)', 'unsupported', () =>
	system.requestPermission('fullDiskAccess'));
await probeDenied('system.checkPermission(bogus)', 'invalid_args', () =>
	system.checkPermission('bogus' as never));
// requestPermission(accessibility/screenRecording/notifications) + authenticate → OS prompts; skipped.
await probe('system.openSettings(notifications) — opens Settings app', () =>
	system.openSettings('notifications'));

// ── phase 2: secureStorage.authenticate — Touch ID prompt; skipped ──
rec({ probe: 'secureStorage.authenticate', ok: null, note: 'skipped — LAContext prompt is modal OS UI' });
console.log('skip secureStorage.authenticate — modal OS prompt');

// ── phase 2: capture (permission-gated — honest either way) ──
await probe('capture.getSources (sources or TCC unavailable)', async () => {
	try {
		const sources = await capture.getSources({ types: ['display'] });
		if (sources.length > 0) {
			const shot = await capture.captureSource(sources[0].id).catch((e) => ({ error: e.code }));
			return { count: sources.length, first: sources[0], shot };
		}
		return { count: 0 };
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code === 'unavailable' || code === 'denied') return { permissionState: code };
		throw e;
	}
});

// ── phase 2: menu depth ──
await probe('menu.items', () => menu.items());
await probe('menu.get(probe.ping)', () => menu.get('probe.ping'));
await probe('menu.update→get→restore', async () => {
	await menu.update({ id: 'probe.ping', text: 'Pinged', enabled: false });
	const updated = await menu.get('probe.ping');
	await menu.update({ id: 'probe.ping', text: 'Ping', enabled: true });
	return { updated, restored: await menu.get('probe.ping') };
});
await probeDenied('menu.update(missing id)', 'unavailable', () =>
	menu.update({ id: 'probe.missing', text: 'X' }));

// ── phase 2: JS-side surface (store/events/dpi/using/isNative) ──
await probe('store roundtrip', async () => {
	if (!('store' in sd)) return { skipped: 'store namespace absent' };
	const s = (sd as Record<string, any>).store;
	await s.set('probeKey', { n: 42 });
	const got = s.get('probeKey');
	await s.delete('probeKey');
	return { got, deleted: s.get('probeKey') === undefined };
});
await probe('events.emit→on local delivery', async () => {
	if (!('events' in sd)) return { skipped: 'events namespace absent' };
	const ev = (sd as Record<string, any>).events;
	let got: unknown = null;
	const off = ev.on('probe-event', (p: unknown) => { got = p; });
	ev.emit('probe-event', { hello: 1 });
	off();
	return { got };
});
await probe('isNative()', () =>
	typeof (sd as Record<string, any>).isNative === 'function'
		? (sd as Record<string, any>).isNative()
		: { skipped: 'absent' });
await probe('shortcuts.acquire→dispose', async () => {
	if (typeof sd.shortcuts.acquire !== 'function') return { skipped: 'acquire absent' };
	await using reg = await sd.shortcuts.acquire({ accelerator: 'CmdOrCtrl+Shift+8' });
	return { id: reg.id };
});
await probe('window.onCloseRequested arm→disarm', async () => {
	if (typeof sd.window.onCloseRequested !== 'function') return { skipped: 'absent' };
	const disarm = await sd.window.onCloseRequested(() => {});
	await disarm();
	return 'armed+disarmed';
});

// ── windowState (pure-JS persistence) ──
await probe('windowState save→load→restore', async () => {
	const saved = await windowState.save();
	const loaded = await windowState.load();
	await windows.setSize(400, 300);
	const restored = await windowState.restore();
	const size = await windows.getSize();
	return { saved: saved.bounds, loaded: loaded?.bounds, restored: restored?.bounds, size };
});

// ── dialog: capability-checked but not invoked (modal, would block) ──
rec({ probe: 'dialog.show*', ok: null, note: 'skipped — modal UI blocks automation; covered by capabilities.describe' });
console.log('skip dialog.show* — modal UI, capability-checked only');

// Let queued events (appearanceChanged from theme.set, notification responses)
// flush through the TSFN before we close the books.
await pump(200);

const summary = {
	total: 0,
	ok: 0,
	fail: 0,
	skip: 0,
	eventsSeen: seenEvents,
};
for (const line of (await Bun.file(OUT).text()).trim().split('\n')) {
	const row = JSON.parse(line);
	if (!('probe' in row)) continue;
	summary.total++;
	if (row.ok === true) summary.ok++;
	else if (row.ok === false) summary.fail++;
	else summary.skip++;
}
rec({ summary });
console.log(`probe done: ${summary.ok}/${summary.total} ok, ${summary.fail} failed, ${summary.skip} skipped`);
console.log('platform events observed:', seenEvents.length ? seenEvents.join(', ') : '(none)');
console.log('results →', OUT);
clearInterval(ticker);
process.exit(0);
