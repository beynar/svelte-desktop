// Tabs in the dashboard (bun test tests/tabs.test.ts): the window's tabs in the title bar and tabs
// inside pages, driven in the real window — screenshots in /tmp/dashboard-tabs-*.png.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

let app: AppHandle;
const titles = (bar: string) => app.eval<string[]>(`[...document.querySelectorAll('${bar} [role=tab]')].map((t) => t.textContent.replace('✕', '').trim())`);
const active = (bar: string) => app.eval<string>(`document.querySelector('${bar} [role=tab][data-active]')?.textContent.replace('✕', '').trim()`);
const shot = (name: string) => Bun.sleep(400).then(() => app.screenshot(`/tmp/dashboard-tabs-${name}.png`));

beforeAll(async () => {
	app = await launch({ dev: true, env: { VITE_TABS_SPLIT: '0' } });
	await app.waitFor('main', { timeout: 30_000 });
	// A clean slate: forget the tabs a previous run left.
	const dir = await app.platform<string>('app', 'getPath', { name: 'userData' });
	await Bun.file(`${dir}/tabs-app.json`).delete().catch(() => {});
	await app.eval(`host.store.load().then(() => (host.store.delete('board-tabs'), host.store.flush())).then(() => true)`);
	await app.eval(`(window.__reloading = true, setTimeout(() => location.assign('/'), 10), true)`);
	await app.waitFor(() => !(window as any).__reloading && !!document.querySelector('.app-tabs [role=tab]'), { timeout: 20_000 });
}, 60_000);
afterAll(() => app?.close(), 20_000);

test('a popover route under <WindowTabs>: the page alone, no tab bar', async () => {
	await app.platform('popover', 'create', { id: 'tabs-popover', route: '/calendar', width: 400, height: 300 });
	const inside = (code: string) => app.platform('webview', 'executeJavaScript', { popoverId: 'tabs-popover', code });
	try {
		// Hydrated, so what the server rendered has been replaced: the page's own content, and no bar.
		for (let i = 0; i < 100 && !(await inside(`document.documentElement.hasAttribute('data-desktop-hydrated')`).catch(() => false)); i++) await Bun.sleep(100);
		expect(await inside(`location.pathname`)).toBe('/calendar');
		expect(await inside(`document.title`)).toBe('Calendar');
		expect(await inside(`document.querySelectorAll('.app-tabs, [data-sd-tab-new]').length`)).toBe(0);
	} finally {
		await app.platform('popover', 'destroy', { id: 'tabs-popover' }).catch(() => {});
	}
}, 30_000);

test('the window tabs: new tab, navigation in the active tab, ⌘-click opens in the background, window title', async () => {
	expect(await titles('.app-tabs')).toEqual(['Overview']);
	await shot('1-start');

	await app.eval(`document.querySelector('.app-tabs [data-sd-tab-new]').click()`);
	await app.waitFor(() => document.querySelectorAll('.app-tabs [role=tab]').length === 2);
	await app.eval(`document.querySelector('a[href="/board"]').click()`); // the sidebar, in the new tab
	await app.waitFor(() => location.pathname === '/board');
	await app.waitFor(() => document.querySelector('.app-tabs [role=tab][data-active]')?.textContent?.includes('Board') ?? false);
	expect(await titles('.app-tabs')).toEqual(['Overview', 'Board']);

	await app.eval(`document.querySelector('a[href="/calendar"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))`);
	await app.waitFor(() => document.querySelectorAll('.app-tabs [role=tab]').length === 3);
	expect(await titles('.app-tabs')).toEqual(['Overview', 'Board', '/calendar']); // not shown yet: its address
	expect(await active('.app-tabs')).toBe('Board'); // opened in the background
	expect(await app.eval('location.pathname')).toBe('/board');
	await shot('2-three-tabs');

	await app.eval(`document.querySelectorAll('.app-tabs [role=tab]')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
	await app.waitFor(() => location.pathname === '/');
	await Bun.sleep(200);
	expect(await app.platform<string>('window', 'getTitle')).toBe('Overview');
});

test('tabs inside a page: one board per tab, kept alive; a new board; fixed segmented tabs on the overview', async () => {
	await app.eval(`document.querySelector('.segmented [role=tab]:nth-child(2)').click()`);
	await app.waitFor(() => document.querySelector('.segmented [role=tab][data-active]')?.textContent?.trim() === 'In progress');
	await shot('3-overview-segmented');

	await app.eval(`document.querySelectorAll('.app-tabs [role=tab]')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
	await app.waitFor(() => location.pathname === '/board' && !!document.querySelector('.board-tabs [role=tab]'));
	expect(await titles('.board-tabs')).toEqual(['Current sprint', 'Product backlog']);
	await app.eval(`document.querySelector('.board-tabs .new-tab').click()`);
	await app.waitFor(() => document.querySelectorAll('.board-tabs [role=tab]').length === 3);
	expect(await active('.board-tabs')).toBe('Board 3');
	expect(await app.eval(`document.querySelectorAll('.board-panel').length`)).toBe(2); // mounted once shown
	expect(await app.eval(`document.querySelectorAll('.board-panel:not([hidden])').length`)).toBe(1);
	await shot('4-board-tabs');
});

test('restored after a reload: the window tabs and the boards', async () => {
	await Bun.sleep(600); // the debounced save
	await app.eval(`(window.__reloading = true, setTimeout(() => location.reload(), 10), true)`);
	await app.waitFor(() => !(window as any).__reloading && document.querySelectorAll('.app-tabs [role=tab]').length === 3, { timeout: 20_000 });
	expect(await titles('.app-tabs')).toEqual(['Overview', 'Board', '/calendar']);
	await app.waitFor(() => document.querySelectorAll('.board-tabs [role=tab]').length === 3, { timeout: 10_000 });
	expect(await titles('.board-tabs')).toEqual(['Current sprint', 'Product backlog', 'Board 3']);
	await shot('5-restored');
});

type Win = { windowId: number; label: string; bounds: { x: number; y: number; width: number; height: number } };
type View = { id: string; url: string | null };
const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, tries = 50): Promise<T> => {
	let v = await get();
	for (let i = 0; i < tries && !ok(v); i++) (await Bun.sleep(100)), (v = await get());
	return v;
};
const views = () => app.platform<View[]>('view', 'list');
const inView = <T>(id: string, code: string) => app.platform<T>('view', 'executeJavaScript', { id, code });
const inWindow = <T>(windowId: number, code: string) => app.platform<T>('webview', 'executeJavaScript', { windowId, code });

test('drag to reorder: native drag and drop, a line where it lands, the window does not move', async () => {
	const order = await titles('.app-tabs');
	const before = await app.platform<Win>('window', 'getInfo');
	// The drag events a real drag makes (a real one: tests/tabs-mouse.test.ts).
	const ok = await app.eval<{ line: string | null; covered: boolean }>(`(async () => {
		const tabs = [...document.querySelectorAll('.app-tabs [role=tab]')];
		const bar = document.querySelector('.app-tabs');
		const dt = new DataTransfer();
		const frame = () => new Promise((r) => setTimeout(r, 50)); // not rAF: it pauses when the window is covered
		const at = (el, dx) => { const b = el.getBoundingClientRect(); return { clientX: b.right + dx, clientY: b.top + b.height / 2 }; };
		const fire = (el, type, xy) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...xy }));
		fire(tabs[0], 'dragstart', at(tabs[0], -20));
		await frame();
		const end = at(tabs.at(-1), -10);
		fire(tabs.at(-1), 'dragenter', end);
		fire(tabs.at(-1), 'dragover', end);
		// The line follows the drag on animation frames: wait for it (they pause while the window is covered).
		let line = null;
		for (let i = 0; i < 20 && !line; i++) { await frame(); line = document.querySelector('.app-tabs [data-sd-tab-drop]')?.style.left ?? null; }
		const covered = document.hidden;
		fire(tabs.at(-1), 'drop', end);
		fire(tabs[0], 'dragend', end);
		await frame();
		return { line, covered };
	})()`);
	if (!ok.covered) expect(ok.line).toMatch(/px$/);
	expect(await titles('.app-tabs')).toEqual([...order.slice(1), order[0]!]);
	expect((await app.platform<Win>('window', 'getInfo')).bounds).toEqual(before.bounds);
});

test('an isolated tab: another site in its own web view, the page hidden while it shows; app events stay out of it', async () => {
	const docs = () => app.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Docs').click()`);
	await docs();
	await app.waitFor(() => !!document.querySelector('[data-sd-tabview]:not([hidden])'), { timeout: 10_000 });
	const list = await until(views, (v) => v.some((x) => x.id === 'app-docs' && !!x.url?.startsWith('https://svelte.dev')));
	expect(list.map((v) => v.id)).toContain('app-docs');
	expect(await app.eval(`document.querySelector('[data-sd-tabcontent]').hidden`)).toBe(true);
	await shot('6-isolated');
	await docs(); // the same tab again, not a second one
	expect((await titles('.app-tabs')).length).toBe(4);
	// Another site never hears the app's events.
	await inView('app-docs', `(window.__got = [], window.__shell?.setSink((n) => window.__got.push(n)), true)`);
	await app.platform('events', 'emit', { channel: 'secret', data: { x: 1 } });
	await Bun.sleep(300);
	expect(await inView<string[]>('app-docs', 'window.__got')).toEqual([]);
	await app.eval(`document.querySelectorAll('.app-tabs [role=tab]')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
	await app.waitFor(() => !document.querySelector('[data-sd-tabcontent]')!.hasAttribute('hidden'));
	expect(await app.eval(`document.querySelector('[data-sd-tabview]').hidden`)).toBe(true); // kept, hidden
}, 30_000);

test('switching quickly lands on the last tab; closing an isolated tab destroys its view', async () => {
	await app.eval(`(() => { const t = window.__tabs; for (let i = 0; i < 5; i++) { t.activate('docs'); t.activate(t.items[0].id); } return true; })()`);
	await Bun.sleep(500);
	expect(await app.eval(`document.querySelector('[data-sd-tabview]').hidden`)).toBe(true);
	expect(await app.eval(`getComputedStyle(document.querySelector('[data-sd-tabcontent]')).display`)).not.toBe('none');
	await app.eval(`(window.__tabs.close('docs'), true)`);
	expect((await until(views, (v) => !v.some((x) => x.id === 'app-docs'))).map((v) => v.id)).not.toContain('app-docs');
}, 30_000);

test('a reload takes the page views along; the tab stays', async () => {
	await app.eval(`(window.__tabs.open({ id: 'docs', url: 'https://example.com', title: 'Example' }), true)`);
	await until(views, (v) => v.some((x) => x.id === 'app-docs'));
	await app.eval(`(window.__tabs.activate(window.__tabs.items[0].id), true)`);
	await Bun.sleep(600); // the debounced save
	await app.eval(`(window.__reloading = true, setTimeout(() => location.reload(), 10), true)`);
	await app.waitFor(() => !(window as any).__reloading && !!(window as any).__tabs?.get('docs'), { timeout: 20_000 });
	expect((await views()).map((v) => v.id)).not.toContain('app-docs');
	await app.eval(`(window.__tabs.close('docs'), true)`);
}, 30_000);

test('an app route isolated in its own view: the page alone, its own group stays out of the menu and the saved tabs', async () => {
	const id = await app.eval<string>(`window.__tabs.open({ path: '/calendar', isolated: true }).id`);
	const list = await until(views, (v) => v.some((x) => x.id === `app-${id}` && !!x.url));
	expect(list.map((v) => v.id)).toContain(`app-${id}`);
	const inside = await until(
		() => inView<{ view: string; bar: boolean; path: string } | null>(`app-${id}`, `document.readyState === 'complete' && location.protocol.startsWith('http') ? { view: window.__desktopView, bar: !!document.querySelector('.app-tabs'), path: location.pathname } : null`).catch(() => null),
		(v) => !!v && !v.bar, // hydrated: the server-rendered chrome is gone
	);
	expect(inside).toEqual({ view: `app-${id}`, bar: false, path: '/calendar' });
	await shot('7-isolated-route');
	await app.eval(`(window.__tabs.close(${JSON.stringify(id)}), true)`);
	await until(views, (v) => !v.some((x) => x.id === `app-${id}`));
}, 30_000);

test('a keepAlive route: a link opens it in its own tab — shown once drawn, the address its own — which keeps running while hidden', async () => {
	await app.waitFor(() => location.pathname === (window as any).__tabs.active?.path); // settled on the active tab
	const before = await titles('.app-tabs');
	const path = await app.eval<string>('location.pathname');
	// The page stays on screen while the tab's view loads out of sight: no blank in between.
	expect(await app.eval(`(document.querySelector('a[href="/activity"]').click(), document.querySelector('[data-sd-tabcontent]').hidden)`)).toBe(false);
	await until(() => titles('.app-tabs'), (t) => t.length === before.length + 1);
	const id = await app.eval<string>('window.__tabs.active.id');
	await until(views, (v) => v.some((x) => x.id === `app-${id}`));
	const hidden = () => app.platform<{ hidden: boolean }>('view', 'getInfo', { id: `app-${id}` }).then((i) => i.hidden);
	expect(await hidden()).toBe(true); // loading, behind the page
	expect(await app.eval('location.pathname')).toBe(path);
	// Drawn: in front, and the window's address is its own — the sidebar follows; the page isn't
	// rendered in the window (the view runs it).
	await app.waitFor(() => location.pathname === '/activity', { timeout: 10_000 });
	const seconds = () => inView<string | null>(`app-${id}`, `document.querySelector('[data-activity-seconds]')?.textContent ?? null`).then((t) => (t ? parseInt(t) : -1)).catch(() => -1);
	const first = await seconds();
	expect(first).toBeGreaterThanOrEqual(0); // drawn before it was shown
	expect(await hidden()).toBe(false);
	expect(await app.eval(`document.querySelector('a[href="/activity"]').getAttribute('aria-current')`)).toBe('page');
	expect(await app.eval(`performance.getEntriesByName('activity:load').length`)).toBe(0); // its load ran in the view only
	expect(await app.eval(`!!document.querySelector('[data-sd-tabcontent] [data-activity-seconds]')`)).toBe(false);
	await shot('8-keepalive');
	await app.eval(`(window.__tabs.activate(window.__tabs.items[0].id), true)`);
	await app.waitFor(() => location.pathname !== '/activity');
	await Bun.sleep(2200);
	expect(await hidden()).toBe(true);
	expect(await seconds()).toBeGreaterThanOrEqual(first + 2); // ran on, hidden
	// A sidebar link from the kept-alive tab: back to a tab of the page.
	await app.eval(`(window.__tabs.activate(${JSON.stringify(id)}), true)`);
	await app.waitFor(() => location.pathname === '/activity');
	// Back and forward: the address and page.url follow (the sidebar).
	await app.eval('history.back()');
	await app.waitFor(() => location.pathname !== '/activity' && !(window as any).__tabs.isIsolated((window as any).__tabs.active));
	expect(await app.eval(`document.querySelector('a[href="/activity"]').getAttribute('aria-current')`)).toBe(null);
	await app.eval('history.forward()');
	await app.waitFor(() => location.pathname === '/activity' && document.querySelector('a[href="/activity"]')!.getAttribute('aria-current') === 'page');
	expect(await app.eval('window.__tabs.active.id')).toBe(id);
	await app.eval(`document.querySelector('a[href="/calendar"]').click()`);
	await app.waitFor(() => location.pathname === '/calendar' && !(window as any).__tabs.isIsolated((window as any).__tabs.active));
	expect((await titles('.app-tabs')).length).toBe(before.length + 1);
	expect(await app.eval(`performance.getEntriesByName('activity:load').length`)).toBe(0);
	expect(await until(() => titles('.app-tabs'), (t) => t.includes('Activity'))).toContain('Activity'); // its page's <title>
	await app.eval(`document.querySelector('a[href="/activity"]').click()`); // again: the same tab
	await Bun.sleep(300);
	expect((await titles('.app-tabs')).length).toBe(before.length + 1);
	expect(await app.eval('window.__tabs.active.id')).toBe(id);
	// ⌘-click: another one, in the background, with its own view — running already, out of sight.
	await app.eval(`document.querySelector('a[href="/activity"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true }))`);
	await until(() => titles('.app-tabs'), (t) => t.length === before.length + 2);
	expect(await app.eval('window.__tabs.active.id')).toBe(id);
	const second = await app.eval<string>(`window.__tabs.items.find((t) => t.path === '/activity' && t.id !== ${JSON.stringify(id)}).id`);
	const ticks = () => inView<string | null>(`app-${second}`, `document.querySelector('[data-activity-seconds]')?.textContent ?? null`).then((t) => (t ? parseInt(t) : -1)).catch(() => -1);
	const started = await until(ticks, (n) => n >= 0);
	expect(started).toBeGreaterThanOrEqual(0);
	expect(await until(ticks, (n) => n >= started + 1)).toBeGreaterThan(started);
	expect((await until(() => app.platform<{ hidden: boolean }>('view', 'getInfo', { id: `app-${second}` }), (i) => i.hidden)).hidden).toBe(true);
	expect(await app.eval('window.__tabs.active.id')).toBe(id);
	await app.eval(`(window.__tabs.activate(${JSON.stringify(second)}), true)`);
	await until(() => app.platform<{ hidden: boolean }>('view', 'getInfo', { id: `app-${second}` }), (i) => !i.hidden);
	await app.eval(`(window.__tabs.close(${JSON.stringify(second)}), window.__tabs.activate(${JSON.stringify(id)}), true)`);
	await app.eval(`(window.__tabs.close(${JSON.stringify(id)}), true)`);
	await until(views, (v) => !v.some((x) => x.id === `app-${id}`));
}, 30_000);

test('a hovered link to a kept-alive route: its view is made ahead (as SvelteKit preloads), and the click shows it at once', async () => {
	await app.eval(`(window.__tabs.items.filter((t) => t.path === '/activity').forEach((t) => window.__tabs.close(t.id)), true)`);
	await until(views, (v) => !v.length);
	const hover = () => app.eval(`(document.querySelector('a[href="/activity"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true })), true)`);
	// data-sveltekit-preload-data="false": not made ahead (the body says "hover").
	await app.eval(`(document.querySelector('a[href="/activity"]').dataset.sveltekitPreloadData = 'false', true)`);
	await hover();
	await Bun.sleep(400);
	expect(await views()).toEqual([]);
	await app.eval(`(delete document.querySelector('a[href="/activity"]').dataset.sveltekitPreloadData, true)`);
	await hover();
	const [made] = await until(views, (v) => v.length === 1);
	expect(made).toBeDefined();
	await until(() => app.platform<{ hidden: boolean; loading: boolean }>('view', 'getInfo', { id: made!.id }), (i) => i.hidden && !i.loading);
	await Bun.sleep(300); // drawn
	// Click → the view in front (the page hidden under it), timed in the page.
	await app.eval(`(() => { const el = document.querySelector('[data-sd-tabcontent]'); window.__shownAfter = 0; const t = performance.now(); new MutationObserver((_, o) => el.hidden && ((window.__shownAfter = performance.now() - t), o.disconnect())).observe(el, { attributes: true }); document.querySelector('a[href="/activity"]').click(); return true; })()`);
	await app.waitFor(() => (window as any).__shownAfter > 0);
	expect(await app.eval<number>('window.__shownAfter')).toBeLessThan(100);
	expect(`app-${await app.eval<string>('window.__tabs.active.id')}`).toBe(made!.id); // that view, not another
	expect((await views()).length).toBe(1);
	await app.eval(`(window.__tabs.close(window.__tabs.active.id), true)`);
	await until(views, (v) => !v.length);
}, 30_000);

test('a view made ahead and not used goes: with the page (a reload) — and after a while', async () => {
	await app.eval(`(document.querySelector('a[href="/activity"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true })), window.__reloading = true, setTimeout(() => location.reload(), 0), true)`);
	await app.waitFor(() => !(window as any).__reloading && !!document.querySelector('.app-tabs [role=tab]'), { timeout: 20_000 });
	await Bun.sleep(500);
	expect(await views()).toEqual([]);
}, 30_000);

test('a tab dragged out opens in its own window (with its title); one taken by another window\'s bar leaves', async () => {
	const before = await titles('.app-tabs');
	const moved = before[1]!;
	// What <TabBar> does when a tab is let go out of the window, nowhere else taking it.
	await app.eval(`(async () => { const t = window.__tabs, id = t.items[1].id; t.handoff(id); await t.release(id, { x: 300, y: 300 }); return true; })()`);
	expect(await until(() => titles('.app-tabs'), (t) => t.length === before.length - 1)).not.toContain(moved);
	const wins = await until(() => app.platform<Win[]>('window', 'list'), (w) => w.length === 2);
	const torn = wins.find((w) => w.label !== 'main')!;
	expect(torn.label).toStartWith('app-');
	const tornTitles = () => inWindow<string[] | null>(torn.windowId, `document.querySelector('.app-tabs [role=tab]') ? [...document.querySelectorAll('.app-tabs [role=tab]')].map((t) => t.textContent.replace('✕', '').trim()) : null`).catch(() => null);
	// Its page's <title> once shown there (a tab never shown had its address).
	const titled = moved.startsWith('/') ? ({ '/': 'Overview', '/board': 'Board', '/calendar': 'Calendar' } as Record<string, string>)[moved]! : moved;
	expect(await until(tornTitles, (t) => t?.[0] === titled)).toEqual([titled]);
	await shot('8-torn-off');

	// Dropped on the torn window's bar: that window takes it (the drop hands it the tab), says so,
	// and it leaves this one.
	const other = (await titles('.app-tabs'))[0]!;
	const handoff = await app.eval<string>(`window.__tabs.handoff(window.__tabs.items[0].id)`);
	await inWindow(torn.windowId, `window.__tabs.receive(${JSON.stringify(handoff)}, 1)`);
	await Bun.sleep(200);
	await app.eval(`window.__tabs.release(window.__tabs.items[0].id, { x: 0, y: 0 }).then(() => true)`);
	expect(await until(tornTitles, (t) => t?.length === 2)).toEqual([titled, other]);
	expect(await titles('.app-tabs')).not.toContain(other);
	await app.platform('window', 'close', { windowId: torn.windowId });
}, 30_000);
