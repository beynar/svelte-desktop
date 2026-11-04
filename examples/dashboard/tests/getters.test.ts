// What a setter sets reads back: state a settings page shows without keeping its own copy.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

let app: AppHandle;
beforeAll(async () => {
	app = await launch();
	await app.waitFor('[data-theme-toggle]', { timeout: 30_000 });
});
afterAll(() => app?.close());

const roundTrip = async (set: string, get: string, values: unknown[]) => {
	for (const value of values) {
		await app.eval(`host.window.${set}(${JSON.stringify(value)})`);
		expect(await app.eval(`host.window.${get}()`)).toEqual(value);
	}
};

test('always on top, all workspaces, aspect ratio, theme', async () => {
	await roundTrip('setAlwaysOnTop', 'isAlwaysOnTop', [true, false]);
	await roundTrip('setVisibleOnAllWorkspaces', 'isVisibleOnAllWorkspaces', [true, false]);
	await roundTrip('setAspectRatio', 'getAspectRatio', [1.5, null]);
	const theme = await app.eval<string>(`host.window.getTheme()`);
	await roundTrip('setTheme', 'getTheme', ['dark', 'light', 'system', theme]);
});

test('min and max size', async () => {
	const before = await app.eval<{ width: number; height: number }>(`host.window.getMinSize()`);
	await app.eval(`host.window.setMinSize(400, 300)`);
	expect(await app.eval(`host.window.getMinSize()`)).toEqual({ width: 400, height: 300 });
	await app.eval(`host.window.setMinSize(${before.width}, ${before.height})`);
	await app.eval(`host.window.setMaxSize(5000, 4000)`);
	expect(await app.eval(`host.window.getMaxSize()`)).toEqual({ width: 5000, height: 4000 });
	await app.eval(`host.window.setMaxSize(0, 0)`);
	expect(await app.eval(`host.window.getMaxSize()`)).toEqual({ width: 0, height: 0 });
});

test('title bar and content size', async () => {
	expect(await app.eval(`host.window.getTitleBarStyle()`)).toMatchObject({ style: expect.any(String), frameless: false });
	const size = await app.eval<{ width: number; height: number }>(`host.window.getContentSize()`);
	expect(size.width).toBeGreaterThan(0);
	expect(size.height).toBeGreaterThan(0);
});

test('vibrancy and glass', async () => {
	const saved = await app.eval(`Promise.all([host.window.getVibrancy(), host.window.getGlass()])`);
	await app.eval(`host.window.setVibrancy('sidebar', { state: 'active' })`);
	expect(await app.eval(`host.window.getVibrancy()`)).toEqual({ material: 'sidebar', state: 'active' });
	expect(await app.eval(`host.window.getGlass()`)).toBeNull();
	await app.eval(`host.window.setVibrancy(null)`);
	expect(await app.eval(`host.window.getVibrancy()`)).toBeNull();
	const { glass } = await app.eval<{ glass: boolean }>(`host.window.setGlass({ style: 'clear', tint: '#336699', cornerRadius: 12 })`);
	if (glass) {
		expect(await app.eval(`host.window.getGlass()`)).toEqual({ style: 'clear', tint: '#336699', cornerRadius: 12 });
		expect(await app.eval(`host.window.getVibrancy()`)).toBeNull();
	} else expect(await app.eval(`host.window.getVibrancy()`)).toMatchObject({ material: 'underWindow' });
	await app.eval(`host.window.setGlass(null)`);
	expect(await app.eval(`host.window.getGlass()`)).toBeNull();
	const [v, g] = saved as [any, any];
	if (v) await app.eval(`host.window.setVibrancy(${JSON.stringify(v.material)}, { state: ${JSON.stringify(v.state)} })`);
	if (g) await app.eval(`host.window.setGlass(${JSON.stringify(g)})`);
});

test('background throttling', async () => {
	expect(await app.eval(`host.webview.getInfo()`)).toMatchObject({ backgroundThrottling: true });
	await app.eval(`host.webview.setBackgroundThrottling(false)`);
	expect(await app.eval(`host.webview.getInfo()`)).toMatchObject({ backgroundThrottling: false });
	await app.eval(`host.webview.setBackgroundThrottling(true)`);
	expect(await app.eval(`host.webview.getInfo()`)).toMatchObject({ backgroundThrottling: true });
});

test('activation policy', async () => {
	expect(await app.eval(`host.app.getActivationPolicy()`)).toBe('regular');
	await app.eval(`host.app.setActivationPolicy('accessory')`);
	expect(await app.eval(`host.app.getActivationPolicy()`)).toBe('accessory');
	await app.eval(`host.app.setActivationPolicy('regular')`);
	expect(await app.eval(`host.app.getActivationPolicy()`)).toBe('regular');
});

test('title bar buttons, decorations, drag, close veto, document, cursor', async () => {
	await roundTrip('setAlwaysOnBottom', 'isAlwaysOnBottom', [true, false]);
	await roundTrip('setMovableByWindowBackground', 'isMovableByWindowBackground', [true, false]);
	await roundTrip('setRepresentedFilename', 'getRepresentedFilename', ['/tmp/report.md', null]);
	const lights = await app.eval(`host.window.getTrafficLightPosition()`);
	await roundTrip('setTrafficLightPosition', 'getTrafficLightPosition', [{ x: 20, y: 18 }, lights]);
	for (const on of [true, false]) {
		await app.eval(`host.window.setCloseVeto(${on})`);
		expect(await app.eval(`host.window.hasCloseVeto()`)).toBe(on);
	}
	expect(await app.eval(`host.window.hasDecorations()`)).toBe(true);
	await app.eval(`host.window.setDecorations(false)`);
	expect(await app.eval(`host.window.hasDecorations()`)).toBe(false);
	await app.eval(`host.window.setDecorations(true)`);
	expect(await app.eval(`host.window.hasDecorations()`)).toBe(true);
	// Hiding twice, one show: a state, not a count.
	await app.eval(`host.window.setCursorHidden(true).then(() => host.window.setCursorHidden(true))`);
	expect(await app.eval(`host.window.isCursorHidden()`)).toBe(true);
	await app.eval(`host.window.setCursorHidden(false)`);
	expect(await app.eval(`host.window.isCursorHidden()`)).toBe(false);
});

test('Dock badge, icon, progress', async () => {
	await app.eval(`host.app.setDockBadge('3')`);
	expect(await app.eval(`host.app.getDockBadge()`)).toBe('3');
	await app.eval(`host.app.setDockBadge(null)`);
	expect(await app.eval(`host.app.getDockBadge()`)).toBeNull();
	await app.eval(`host.notifications.setBadge(7)`);
	expect(await app.eval(`host.notifications.getBadge()`)).toBe(7);
	await app.eval(`host.notifications.setBadge(null)`);
	expect(await app.eval(`host.notifications.getBadge()`)).toBeNull();
	expect(await app.eval(`host.app.getDockIcon()`)).toBeNull();
	await app.eval(`host.app.setDockIcon('star.fill')`);
	expect(await app.eval(`host.app.getDockIcon()`)).toBe('star.fill');
	await app.eval(`host.app.setDockIcon(null)`);
	expect(await app.eval(`host.app.getDockIcon()`)).toBeNull();
	await app.eval(`host.app.setDockProgress({ status: 'normal', completed: 2, total: 5 })`);
	expect(await app.eval(`host.app.getDockProgress()`)).toEqual({ status: 'normal', completed: 2, total: 5 });
	await app.eval(`host.app.setDockProgress({ status: 'none' })`);
	expect(await app.eval(`host.app.getDockProgress()`)).toEqual({ status: 'none' });
});

test('menus and content rules', async () => {
	const dock = [{ id: 'one', title: 'One' }];
	expect(await app.eval(`host.menu.getDockMenu()`)).toBeNull();
	await app.eval(`host.menu.setDockMenu(${JSON.stringify(dock)})`);
	expect(await app.eval(`host.menu.getDockMenu()`)).toMatchObject(dock);
	await app.eval(`host.menu.setDockMenu([])`);
	expect(await app.eval(`host.menu.getDockMenu()`)).toBeNull();
	const menus = () => app.eval<{ name: string }[]>(`host.menu.getAppMenu()`).then((list) => list.map((m) => m.name));
	expect(await menus()).toEqual(['Tab']); // <WindowTabs> inserts its menu
	await app.eval(`host.menu.insert({ name: 'Extras', items: [{ id: 'x', title: 'X' }] })`);
	expect(await menus()).toEqual(['Tab', 'Extras']);
	await app.eval(`host.menu.remove('Extras')`);
	expect(await menus()).toEqual(['Tab']);
	const rules = [{ trigger: { 'url-filter': 'ads\\\\.example' }, action: { type: 'block' } }];
	await app.eval(`host.webview.setContentRules({ id: 'ads', rules: ${JSON.stringify(rules)} })`);
	expect(await app.eval(`host.webview.listContentRules()`)).toEqual([{ id: 'ads', rules }]);
	await app.eval(`host.webview.removeContentRules('ads')`);
	expect(await app.eval(`host.webview.listContentRules()`)).toEqual([]);
});

test('recovery', async () => {
	expect(await app.eval(`host.webview.getInfo()`)).toMatchObject({ recovery: 'reload' });
	await app.eval(`host.webview.setRecovery('manual')`);
	expect(await app.eval(`host.webview.getInfo()`)).toMatchObject({ recovery: 'manual' });
	await app.eval(`host.webview.setRecovery('reload')`);
});

test('default URL handler', async () => {
	expect(await app.eval(`host.deepLink.isDefault('https')`)).toBe(false);
	expect(await app.eval(`host.deepLink.isDefault('no-app-opens-this')`)).toBe(false);
	expect(await app.eval(`host.deepLink.isDefault('not a scheme').catch((e) => e.code)`)).toBe('invalid_args');
});

// The same state without `await`, reactive: `host.window.alwaysOnTop`.
const until = (code: string) => app.waitFor(new Function(`return ${code}`) as () => boolean, { timeout: 3000 });

test('fields: known once read, right after a setter, none of it awaited', async () => {
	const read = (field: string) => app.eval(`host.${field}`);
	await read('window.alwaysOnTop');
	await until(`host.window.alwaysOnTop === false`);
	await app.eval(`host.window.setAlwaysOnTop(true)`);
	expect(await read('window.alwaysOnTop')).toBe(true);
	await app.eval(`host.window.setAlwaysOnTop(false)`);
	expect(await read('window.alwaysOnTop')).toBe(false);
	// Never read before: the setter makes it known.
	await app.eval(`host.window.setMinSize(410, 310)`);
	expect(await read('window.minSize')).toEqual({ width: 410, height: 310 });
	await app.eval(`host.window.setMinSize(0, 0)`);
	await app.eval(`host.app.setDockBadge('5')`);
	expect(await read('app.dockBadge')).toBe('5');
	await app.eval(`host.app.setDockBadge(null)`);
	await app.eval(`host.notifications.setBadge(2)`);
	expect(await read('notifications.badge')).toBe(2);
	await app.eval(`host.notifications.setBadge(null)`);
	await app.eval(`host.window.setVibrancy('sidebar', { state: 'active' })`);
	expect(await read('window.vibrancy')).toEqual({ material: 'sidebar', state: 'active' });
	await app.eval(`host.window.setVibrancy(null)`);
	expect(await read('window.vibrancy')).toBeNull();
	await app.eval(`host.webview.setBackgroundThrottling(false)`);
	expect(await read('webview.backgroundThrottling')).toBe(false);
	await app.eval(`host.webview.setBackgroundThrottling(true)`);
	await app.eval(`host.window.setRepresentedFilename('/tmp/a.md')`);
	expect(await read('window.representedFilename')).toBe('/tmp/a.md');
	await app.eval(`host.window.setRepresentedFilename(null)`);
	const { style } = await app.eval<{ style: string }>(`host.window.getTitleBarStyle()`);
	await app.eval(`host.window.setTitleBarStyle('transparent')`);
	expect(await read('window.titleBarStyle')).toBe('transparent');
	await app.eval(`host.window.setTitleBarStyle(${JSON.stringify(style)})`);
	await until(`host.window.frameless === false`);
	await until(`host.app.activationPolicy === null || host.app.activationPolicy === 'regular'`);
	expect(await read('app.loginItem')).toBeNull(); // first read: known a moment later
	await until(`host.app.loginItem && host.app.loginItem.available === true`);
	await app.eval(`host.deepLink.isDefault('no-app-opens-this')`);
	expect(await read(`deepLink.defaults['no-app-opens-this']`)).toBe(false);
});

test('fields: a setter in another context reaches this page', async () => {
	await app.eval(`host.window.alwaysOnTop`);
	await until(`host.window.alwaysOnTop === false`);
	// The service, not the store: nothing here writes the field.
	await app.eval(`host.windows.setAlwaysOnTop(true)`);
	await until(`host.window.alwaysOnTop === true`);
	await app.eval(`host.windows.setAlwaysOnTop(false)`);
	await until(`host.window.alwaysOnTop === false`);
	// From another window's page.
	const { windowId } = await app.platform<{ windowId: number }>('window', 'create', { label: 'second', path: '/', visible: false, width: 320, height: 240 });
	const inSecond = (code: string) => app.platform('webview', 'executeJavaScript', { windowId, code });
	for (let i = 0; i < 100; i++) {
		if (await inSecond(`typeof host !== 'undefined' && host.available`).catch(() => false)) break;
		await Bun.sleep(100);
	}
	await inSecond(`host.windows.setAlwaysOnTop(true, 0)`);
	await until(`host.window.alwaysOnTop === true`);
	await inSecond(`host.windows.setAlwaysOnTop(false, 0)`);
	await until(`host.window.alwaysOnTop === false`);
	await app.platform('window', 'close', { windowId });
}, 30_000);
