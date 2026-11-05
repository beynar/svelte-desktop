// The example as it ships: its tabs in panes (`bun run build`). The other tests build with
// `bun run build:test`, one page at a time; this one is for a build without it.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

let app: AppHandle;
const until = async (check: () => Promise<boolean>, what: string, ms = 15_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check().catch(() => false)) return;
		await Bun.sleep(50);
	}
	throw new Error(`timed out: ${what}`);
};
const panes = () => app.eval<{ id: string; tabs: string[]; active: string }[]>(`window.__tabs.panes?.panes.map((p) => ({ id: p.id, tabs: [...p.tabs], active: p.active })) ?? []`);
const inView = <T>(tab: string, code: string) => app.platform<T>('view', 'executeJavaScript', { id: `app-${tab}`, code });

beforeAll(async () => {
	app = await launch();
	await app.waitFor(() => !!(globalThis as any).__tabs?.items?.length, { timeout: 30_000 });
}, 60_000);
afterAll(() => app?.close());

test('its tabs are in panes, each page in its own view, inside the shell', async () => {
	await until(async () => (await panes()).length >= 1, 'a pane');
	expect(await app.eval(`!!document.querySelector('[data-slot="sidebar"], nav') && !!document.querySelector('[data-sd-pane] .pane-bar [role=tab]')`)).toBe(true);
	const tab = (await panes())[0]!.active;
	await until(() => inView<boolean>(tab, `!!document.querySelector('h1, h2, main, [data-slot]') && document.documentElement.hasAttribute('data-desktop-hydrated')`), 'its page');
});

test('split to the right: two panes side by side, a page each', async () => {
	await app.eval(`(window.__tabs.split('right'), true)`);
	await until(async () => (await panes()).length === 2, 'two panes');
	const [left, right] = await panes();
	await until(async () => {
		const [a, b] = await Promise.all([left!.active, right!.active].map((t) => app.platform<{ x: number; width: number }>('view', 'getBounds', { id: `app-${t}` })));
		return b!.x >= a!.x + a!.width;
	}, 'side by side');
	await until(() => inView<boolean>(right!.active, `document.documentElement.hasAttribute('data-desktop-hydrated')`), 'its page');
	// What can be grabbed between them: wider than the line that shows, and no web view over it.
	const [a, b] = await Promise.all([left!.active, right!.active].map((t) => app.platform<{ x: number; width: number }>('view', 'getBounds', { id: `app-${t}` })));
	expect(b!.x - (a!.x + a!.width)).toBeGreaterThanOrEqual(6);
	expect(await app.eval(`document.querySelector('[data-sd-splitter]').getBoundingClientRect().width`)).toBeGreaterThanOrEqual(6);
});

// With the real mouse: where it's a real pointer, on Linux under Xvfb (it can't take anyone's keyboard).
test.skipIf(!Bun.which('xdotool') || process.platform !== 'linux')('the boundary drags from anywhere it can be grabbed, along the pages and along the bars', async () => {
	const out = await Bun.$`xdotool search --onlyvisible --name Overview getwindowgeometry --shell`.nothrow().text();
	const at = (k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(out)?.[1] ?? 0);
	const inset = await app.eval<number>('outerHeight - innerHeight');
	const size = () => app.eval<number>('window.__tabs.panes.root.sizes[0]');
	const measure = () =>
		app.eval<{ x: number; y: number; bottom: number; bar: number }>(`(() => {
			const r = document.querySelector('[data-sd-splitter="row"]').getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top, bottom: r.bottom, bar: document.querySelector('.pane-bar').getBoundingClientRect().height };
		})()`);
	const results: string[] = [];
	for (const [where, offsets] of [
		['pages', [-3, -2, 0, 2, 3]], // along the pages: the gap
		['bars', [-5, -3, 0, 3, 5]], // along the bars: more
	] as const)
		for (const dx of offsets) {
			await app.eval(`(() => { const t = window.__tabs.panes; t.root.sizes[0] = t.root.sizes[1] = 0.5; t.revision++; return true; })()`);
			await Bun.sleep(400); // the views where the panes are
			const line = await measure();
			const before = await size();
			const X = Math.round(at('X') + line.x + dx);
			const Y = Math.round(at('Y') + inset + (where === 'pages' ? (line.y + line.bottom) / 2 : line.y + line.bar / 2));
			await Bun.$`xdotool mousemove ${X} ${Y}`;
			await Bun.sleep(50);
			const hovered = await app.eval<boolean>(`!!document.querySelector('[data-sd-splitter]:hover')`);
			await Bun.$`xdotool mousedown 1`;
			await Bun.sleep(30);
			await Bun.$`xdotool mousemove ${X - 40} ${Y}`;
			await Bun.sleep(60);
			await Bun.$`xdotool mouseup 1`;
			await Bun.sleep(60);
			const moved = Math.abs((await size()) - before) > 0.01;
			results.push(`${where} ${dx}: hover ${hovered} drag ${moved}`);
		}
	expect(results.filter((r) => r.endsWith('drag false'))).toEqual([]);
});

test("the sidebar moves the pane in focus; the board's own tabs work in it", async () => {
	const [, right] = await panes();
	await app.eval(`(window.__tabs.focus('${right!.id}'), true)`);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${right!.active}'`), 'in focus');
	await app.eval(`(document.querySelector('a[href="/board"]').click(), true)`);
	await until(async () => (await inView<string>(right!.active, 'location.pathname')) === '/board', 'the board');
	await until(() => inView<boolean>(right!.active, `!!document.querySelector('.board-tabs [role=tab]')`), 'its tabs');
	await until(() => app.eval<boolean>(`location.pathname === '/board'`), 'the address');
});

test("a tab's data reaches the others and the window's sidebar", async () => {
	const [left, right] = await panes();
	await app.eval(`(window.__tabs.focus('${left!.id}'), true)`);
	const badge = () => app.eval<number>(`globalThis.__dashboardData.board.columns.filter((c) => c.id !== 'done').reduce((n, c) => n + c.cards.length, 0)`);
	const before = await badge();
	await inView(right!.active, `(globalThis.__dashboardData.board.columns[0].cards.pop(), true)`);
	await until(async () => (await badge()) === before - 1, 'in the window');
	await until(() => inView<boolean>(left!.active, `globalThis.__dashboardData.board.columns.filter((c) => c.id !== 'done').reduce((n, c) => n + c.cards.length, 0) === ${before - 1}`), 'in the other tab');
});

test('a tab opened since: it takes the data, nobody loses theirs', async () => {
	const badge = () => app.eval<number>(`globalThis.__dashboardData.board.columns.filter((c) => c.id !== 'done').reduce((n, c) => n + c.cards.length, 0)`);
	const before = await badge();
	const id = await app.eval<string>(`window.__tabs.open('/calendar', { reuse: false }).id`);
	await until(() => inView<boolean>(id, `document.documentElement.hasAttribute('data-desktop-hydrated') && !!globalThis.__dashboardData`), 'its page');
	await until(() => inView<boolean>(id, `globalThis.__dashboardData.board.columns.filter((c) => c.id !== 'done').reduce((n, c) => n + c.cards.length, 0) === ${before}`), 'the data');
	await Bun.sleep(500);
	expect(await badge()).toBe(before);
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test('the Native page, loaded in a pane, sets the material of the window; a page that closes without having set it leaves it', async () => {
	const id = await app.eval<string>(`window.__tabs.open('/native', { reuse: false }).id`);
	await until(() => inView<boolean>(id, `document.documentElement.hasAttribute('data-desktop-hydrated') && !!document.querySelector('h1, h2')`), 'its page, served and hydrated');
	const windowId = await app.eval<number>(`host.window.getInfo().then((i) => i.windowId)`);
	const send = (backdrop: string | null, from: string) => inView(id, `(host.broadcast('dashboard:backdrop', { windowId: ${windowId}, from: '${from}', data: { backdrop: ${JSON.stringify(backdrop)}, intensity: 100, tint: 'none' } }), true)`);
	await send('sidebar', 'a');
	await until(() => app.eval<boolean>(`document.documentElement.dataset.backdrop === 'sidebar'`), 'on the window');
	expect(await app.eval(`getComputedStyle(document.querySelector('[data-slot="sidebar-wrapper"]')).getPropertyValue('--desktop-material').trim()`)).toBe('sidebar');
	await send(null, 'b');
	await Bun.sleep(200);
	expect(await app.eval(`document.documentElement.dataset.backdrop`)).toBe('sidebar');
	await send(null, 'a');
	await until(() => app.eval<boolean>(`document.documentElement.dataset.backdrop === undefined`), 'off');
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test("a long page scrolls as a document (Back in the window brings its position back)", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/native', { reuse: false }).id`);
	await until(() => inView<boolean>(id, `document.documentElement.hasAttribute('data-desktop-hydrated') && document.documentElement.scrollHeight > innerHeight`), 'its page, longer than the pane');
	await inView(id, `(scrollTo(0, 300), true)`);
	await until(() => inView<boolean>(id, `scrollY === 300`), 'scrolled');
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test('the tab that set the material closes: the window goes back', async () => {
	const id = await app.eval<string>(`window.__tabs.open('/native', { reuse: false }).id`);
	await until(() => inView<boolean>(id, `document.documentElement.hasAttribute('data-desktop-hydrated')`), 'its page');
	const windowId = await app.eval<number>(`host.window.getInfo().then((i) => i.windowId)`);
	await inView(id, `(host.broadcast('dashboard:backdrop', { windowId: ${windowId}, from: 'app-${id}', data: { backdrop: 'hud', intensity: 100, tint: 'none' } }), true)`);
	await until(() => app.eval<boolean>(`document.documentElement.dataset.backdrop === 'hud'`), 'on the window');
	await app.eval(`(window.__tabs.close('${id}'), true)`);
	await until(() => app.eval<boolean>(`document.documentElement.dataset.backdrop === undefined`), 'off');
});

test("the Dock menu's navigation: the active tab of the window in front", async () => {
	const tab = await app.eval<string>(`window.__tabs.activeId`);
	const path = await app.eval<string>(`window.__tabs.get('${tab}').path`);
	const to = path === '/calendar' ? '/form' : '/calendar';
	await inView(tab, `(host.broadcast('dashboard:open', '${to}'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === to, 'there');
});

test('/activity is one tab, wherever it is', async () => {
	await app.eval(`(document.querySelector('a[href="/activity"]').click(), true)`);
	await until(() => app.eval<boolean>(`window.__tabs.items.some((t) => t.path === '/activity')`), 'its tab');
	const count = await app.eval<number>(`window.__tabs.items.filter((t) => t.path === '/activity').length`);
	expect(count).toBe(1);
});
