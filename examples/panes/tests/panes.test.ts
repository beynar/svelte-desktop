// <WindowTabs split> in the built app: each tab in its own process, panes made and resized, tabs
// moved between them without their page reloading, the layout back at the next launch.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

type Box = { x: number; y: number; width: number; height: number };
let app: AppHandle;
const reset = () =>
	app.eval(`(() => {
		const t = window.__tabs;
		for (const x of [...t.items]) t.close(x.id);
		return true;
	})()`);
const start = async () => {
	app = await launch();
	await app.waitFor(() => !!(globalThis as any).__tabs?.items?.length, { timeout: 30_000 });
};
beforeAll(async () => {
	await start();
	// The layout of the last run comes back: from one pane.
	await reset();
	await until(async () => (await panes()).length === 1 && (await items()).length === 1, 'one pane');
}, 60_000);
afterAll(() => app?.close());
// WebKit refuses a page's 101st history call in 10 seconds: a SecurityError, goto() rejects and the
// address stays. Nobody clicks that fast. These tests do, the faster the machine the sooner, so each
// starts with room for its own calls in the window's page. No test here makes more than 40.
beforeEach(() =>
	until(
		() =>
			app.eval<boolean>(`(() => {
				const g = globalThis;
				if (!g.__historyCalls) {
					g.__historyCalls = [];
					for (const on of [History.prototype, history])
						for (const m of ['pushState', 'replaceState']) {
							const call = on[m];
							on[m] = function (...args) {
								g.__historyCalls.push(Date.now());
								return call.apply(this, args);
							};
						}
				}
				g.__historyCalls = g.__historyCalls.filter((t) => Date.now() - t < 10000);
				return g.__historyCalls.length <= 60;
			})()`),
		'room in the history limit',
		11_000,
	),
);

const items = () => app.eval<{ id: string; path?: string; title?: string }[]>(`window.__tabs.items.map((t) => ({ id: t.id, path: t.path, title: t.title }))`);
const panes = () => app.eval<{ id: string; tabs: string[]; active: string; focused: boolean }[]>(`window.__tabs.panes.panes.map((p) => ({ id: p.id, tabs: [...p.tabs], active: p.active, focused: p.id === window.__tabs.panes.focusedId }))`);
const viewId = (tab: string) => `app-${tab}`;
const bounds = (tab: string) => app.platform<Box>('view', 'getBounds', { id: viewId(tab) });
const inView = <T>(tab: string, code: string) => app.platform<T>('view', 'executeJavaScript', { id: viewId(tab), code });
const body = (pane: string) => app.eval<Box>(`(() => { const r = document.querySelector('[data-sd-pane="${pane}"] > [data-sd-pane-body]').getBoundingClientRect(); const x = Math.round(r.left), y = Math.round(r.top); return { x, y, width: Math.round(r.right) - x, height: Math.round(r.bottom) - y }; })()`);
const until = async (check: () => Promise<boolean>, what: string, ms = 8000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check().catch(() => false)) return;
		await Bun.sleep(30);
	}
	throw new Error(`timed out: ${what}`);
};
/** Links in the window's page, followed one right after the other. */
const click = (...hrefs: string[]) =>
	app.eval(`(() => {
		for (const href of ${JSON.stringify(hrefs)}) {
			const a = Object.assign(document.createElement('a'), { href });
			document.body.append(a);
			a.click();
			a.remove();
		}
		return true;
	})()`);
/** On screen and running: on macOS a view's page is server-rendered, so it's there before it's hydrated. */
const drawn = (tab: string) => until(() => inView<boolean>(tab, `!!document.querySelector('[data-alive]') && document.documentElement.hasAttribute('data-desktop-hydrated')`), `${tab} drawn`);
const onBody = async (tab: string) => until(async () => {
	const pane = (await panes()).find((p) => p.tabs.includes(tab))!;
	const [a, b] = await Promise.all([bounds(tab), body(pane.id)]);
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}, `${tab}'s view on its pane`);

/** A press on a tab and moves in the page, as the mouse would send them (the real mouse: panes-mouse.test.ts). */
const dragTab = (tab: string, to: { x: number; y: number }, opts: { release?: boolean } = {}) =>
	app.eval(`(async () => {
		const el = document.getElementById('app-tab-${tab}');
		const r = el.getBoundingClientRect();
		const at = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, button: 0, clientX: x, clientY: y, screenX: x, screenY: y }));
		at('pointerdown', r.left + 10, r.top + 10);
		at('pointermove', r.left + 30, r.top + 30);
		at('pointermove', ${to.x}, ${to.y});
		${opts.release === false ? '' : `at('pointerup', ${to.x}, ${to.y});`}
		return true;
	})()`);

test('each tab is its own web view, in its own process', async () => {
	await app.eval(`window.__tabs.open('/threads/1', { split: 'right', reuse: false })`);
	await until(async () => (await panes()).length === 2, 'two panes');
	const [a, b] = await items();
	await Promise.all([drawn(a!.id), drawn(b!.id)]);
	const metrics = await app.eval<{ processes: { type: string; pid: number }[] }>(`host.app.metrics().catch(() => ({ processes: [] }))`);
	// The window's page and one per tab: three content processes.
	if (process.platform === 'darwin') expect(new Set(metrics.processes.filter((p) => p.type === 'webview').map((p) => p.pid)).size).toBe(3);
	expect(await inView<string>(b!.id, `document.title`)).toBe('Thread 1');
});

test('panes sit side by side, each view on its body', async () => {
	const [left, right] = await panes();
	await onBody(left!.tabs[0]!);
	await onBody(right!.tabs[0]!);
	const [a, b] = await Promise.all([bounds(left!.tabs[0]!), bounds(right!.tabs[0]!)]);
	expect(a.x + a.width).toBeLessThanOrEqual(b.x);
	expect(a.y).toBe(b.y);
	expect(a.height).toBe(b.height);
});

test('the boundary between two panes follows the pointer, past the minimum and back', async () => {
	const [left, right] = await panes();
	const tab = left!.tabs[0]!;
	const before = await bounds(tab);
	const line = (code: string) => app.eval(`(() => {
		const el = document.querySelector('[data-sd-splitter]');
		const r = el.getBoundingClientRect();
		window.__line ??= r.left;
		const at = (type, dx, extra = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, button: 0, clientX: window.__line + dx, clientY: r.top + 40, ...extra }));
		${code}
		return true;
	})()`);
	await line(`at('pointerdown', 0); at('pointermove', -120);`);
	await until(async () => Math.abs((await bounds(tab)).width - (before.width - 120)) <= 1, 'narrower');
	await onBody(right!.tabs[0]!);
	expect(await app.eval(`document.querySelector('[data-sd-splitter]').hasAttribute('data-dragging')`)).toBe(true);
	// Far past the minimum, then back a little: under the pointer, not off by what it overshot.
	await line(`at('pointermove', -5000);`);
	await until(async () => (await bounds(tab)).width === 180, 'stopped at the minimum');
	await line(`at('pointermove', -40);`);
	await until(async () => Math.abs((await bounds(tab)).width - (before.width - 40)) <= 1, 'back under the pointer');
	// The mouse moving with its button up: the release never reached us, the drag is over.
	await line(`at('pointermove', -60, { pointerType: 'mouse', buttons: 0 });`);
	expect(await app.eval(`document.querySelector('[data-sd-splitter]').hasAttribute('data-dragging')`)).toBe(false);
	await line(`at('pointermove', 300);`);
	await Bun.sleep(150);
	expect(Math.abs((await bounds(tab)).width - (before.width - 40))).toBeLessThanOrEqual(1);
	// Escape: back where it was.
	await line(`at('pointerdown', 0); at('pointermove', 80); dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
	await until(async () => Math.abs((await bounds(tab)).width - (before.width - 40)) <= 1, 'undone');
	// The keys.
	const key = (k: string) => app.eval(`(document.querySelector('[data-sd-splitter]').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true })), true)`);
	await key('Home');
	await until(async () => (await bounds(tab)).width === 180, 'Home');
	await key('ArrowRight');
	await until(async () => Math.abs((await bounds(tab)).width - 204) <= 1, 'an arrow');
	expect(await app.eval(`document.querySelector('[data-sd-splitter]').getAttribute('aria-valuenow')`)).toBe(String(Math.round((204 / (before.width * 2)) * 100)));
	expect(await app.eval(`document.querySelector('[data-sd-splitter]').getAttribute('aria-controls').split(' ').every((id) => document.getElementById(id))`)).toBe(true);
	// A double click: equal again.
	await app.eval(`(document.querySelector('[data-sd-splitter]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true)`);
	await until(async () => Math.abs((await bounds(tab)).width - before.width) <= 1, 'equal');
	await onBody(right!.tabs[0]!);
});

test('a smaller window: no pane under the minimum while there is room', async () => {
	const [left] = await panes();
	const tab = left!.tabs[0]!;
	await app.eval(`(document.querySelector('[data-sd-splitter]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })), true)`);
	await until(async () => (await bounds(tab)).width === 180, 'at the minimum');
	const { bounds: was } = await app.platform<{ bounds: Box }>('window', 'getInfo');
	await app.platform('window', 'setBounds', { ...was, width: 760 });
	await until(async () => Math.abs((await bounds(tab)).width - 180) <= 1 && (await app.eval<number>(`innerWidth`)) === 760, 'still the minimum');
	await app.platform('window', 'setBounds', was);
	await app.eval(`(document.querySelector('[data-sd-splitter]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true)`);
	await onBody(tab);
});

test('dragged over a side of a pane: its view makes room, the zone shows, and Escape leaves it all', async () => {
	const [left, right] = await panes();
	const tab = left!.tabs[0]!;
	const target = right!.tabs[0]!;
	const box = await body(right!.id);
	const before = await bounds(target);
	await app.eval(`window.__tabs.open('/threads/9', { background: false, pane: '${left!.id}', reuse: false })`);
	await until(async () => (await panes())[0]!.tabs.length === 2, 'two tabs on the left');
	await dragTab(tab, { x: box.x + box.width - 20, y: box.y + box.height / 2 }, { release: false });
	await until(async () => Math.abs((await bounds(target)).width - before.width / 2) <= 1, 'room made');
	expect(await app.eval(`document.querySelector('[data-sd-pane-drop]').getAttribute('data-sd-pane-drop')`)).toBe('right');
	expect(await app.eval(`document.documentElement.hasAttribute('data-sd-pane-dragging')`)).toBe(true);
	await app.eval(`(dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
	await onBody(target);
	expect(await app.eval(`document.querySelector('[data-sd-pane-drop]')`)).toBeNull();
	expect((await panes()).length).toBe(2);
});

for (const zone of ['left', 'right', 'top', 'bottom'] as const) {
	test(`over the ${zone} side of a pane: the zone shows there, and its view leaves exactly that room`, async () => {
		const [left, right] = await panes();
		const tab = left!.tabs[0]!;
		const target = right!.tabs[0]!;
		await onBody(target);
		const box = await body(right!.id);
		const at = {
			left: { x: box.x + 30, y: box.y + box.height / 2 },
			right: { x: box.x + box.width - 30, y: box.y + box.height / 2 },
			top: { x: box.x + box.width / 2, y: box.y + 30 },
			bottom: { x: box.x + box.width / 2, y: box.y + box.height - 60 },
		}[zone];
		await dragTab(tab, at, { release: false });
		await until(() => app.eval<boolean>(`document.querySelector('[data-sd-pane="${right!.id}"] [data-sd-pane-drop]')?.getAttribute('data-sd-pane-drop') === '${zone}'`), `the ${zone} zone`);
		const half = { left: 'x', right: 'width', top: 'y', bottom: 'height' }[zone];
		await until(async () => {
			const v = await bounds(target);
			const near = (a: number, b: number) => Math.abs(a - b) <= 1;
			return zone === 'left' ? near(v.x, box.x + box.width / 2) && near(v.y, box.y) && near(v.width, box.width / 2) && near(v.height, box.height)
				: zone === 'right' ? near(v.x, box.x) && near(v.y, box.y) && near(v.width, box.width / 2) && near(v.height, box.height)
				: zone === 'top' ? near(v.x, box.x) && near(v.y, box.y + box.height / 2) && near(v.height, box.height / 2) && near(v.width, box.width)
				: near(v.x, box.x) && near(v.y, box.y) && near(v.height, box.height / 2) && near(v.width, box.width);
		}, `its view off the ${zone} half (${half})`);
		// The zone drawn is exactly the room left: the half of the body the view isn't on.
		const zoneBox = await app.eval<Box>(`(() => { const r = document.querySelector('[data-sd-pane-drop]').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
		const want: Box = {
			left: { x: box.x, y: box.y, width: box.width / 2, height: box.height },
			right: { x: box.x + box.width / 2, y: box.y, width: box.width / 2, height: box.height },
			top: { x: box.x, y: box.y, width: box.width, height: box.height / 2 },
			bottom: { x: box.x, y: box.y + box.height / 2, width: box.width, height: box.height / 2 },
		}[zone];
		for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(zoneBox[k] - want[k])).toBeLessThanOrEqual(1);
		const v = await bounds(target);
		expect(Math.abs(v.width * v.height + zoneBox.width * zoneBox.height - box.width * box.height)).toBeLessThanOrEqual(Math.max(box.width, box.height));
		await app.eval(`(dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
		await onBody(target);
	});
}

test('dropping on each side of a pane puts the tab there', async () => {
	const [left, right] = await panes();
	const box = await body(right!.id);
	const tab = left!.tabs[0]!;
	const place = async (at: { x: number; y: number }) => {
		// Back where it was after each: the room of a pane going returns where it came from.
		expect(await body(right!.id)).toEqual(box);
		await dragTab(tab, at);
		await until(async () => (await panes()).length === 3, 'a pane made');
		await onBody(tab);
		await onBody(right!.tabs[0]!);
		const here = await bounds(tab);
		const other = await bounds(right!.tabs[0]!);
		// Back in the first pane.
		await app.eval(`(window.__tabs.panes.moveToPane('${tab}', '${left!.id}', 0), true)`);
		await until(async () => (await panes()).length === 2, 'back');
		await onBody(right!.tabs[0]!);
		return { here, other };
	};
	let r = await place({ x: box.x + 30, y: box.y + box.height / 2 });
	expect(r.here.x + r.here.width).toBeLessThanOrEqual(r.other.x);
	r = await place({ x: box.x + box.width - 30, y: box.y + box.height / 2 });
	expect(r.other.x + r.other.width).toBeLessThanOrEqual(r.here.x);
	r = await place({ x: box.x + box.width / 2, y: box.y + 30 });
	expect(r.here.y + r.here.height).toBeLessThanOrEqual(r.other.y);
	r = await place({ x: box.x + box.width / 2, y: box.y + box.height - 60 });
	expect(r.other.y + r.other.height).toBeLessThanOrEqual(r.here.y);
});

test('bind:value and the active tab: your code sets it, its pane shows it', async () => {
	const [left, right] = await panes();
	await app.eval(`(window.__setValue('${left!.tabs.at(-1)}'), true)`);
	await until(async () => (await panes())[0]!.active === left!.tabs.at(-1) && (await panes())[0]!.focused, 'shown and in focus');
	await app.eval(`(window.__setValue('${right!.tabs[0]}'), true)`);
	await until(async () => (await panes())[1]!.focused, 'the other pane in focus');
});

test('bind:value for a tab that comes after: its pane shows it when it does', async () => {
	const [left] = await panes();
	const late = 'late-tab';
	await app.eval(`(window.__tabs.focus('${left!.id}'), window.__setValue('${late}'), true)`);
	await Bun.sleep(100);
	await app.eval(`(window.__tabs.items = [...window.__tabs.items, { id: '${late}', path: '/threads/5' }], true)`);
	await until(async () => (await panes()).some((p) => p.active === late), 'shown');
	await drawn(late);
	await app.eval(`(window.__tabs.close('${late}'), true)`);
	await until(async () => !(await items()).some((t) => t.id === late), 'closed');
});

test('panes moving without changing size: the views follow', async () => {
	const [left] = await panes();
	const tab = left!.active;
	await onBody(tab);
	await app.platform('window', 'focus');
	const root = `document.querySelector('[data-sd-panes]')`;
	const { height } = await app.eval<{ height: number }>(`(() => ({ height: ${root}.getBoundingClientRect().height }))()`);
	await app.eval(`(${root}.style.height = '${height - 60}px', ${root}.style.flex = 'none', true)`);
	await onBody(tab);
	const was = await bounds(tab);
	await app.eval(`(${root}.style.marginTop = '40px', true)`); // the same size, 40 px lower
	await until(async () => (await bounds(tab)).y === was.y + 40, 'moved down', 4000);
	await app.eval(`(${root}.style.marginTop = '', ${root}.style.height = '', ${root}.style.flex = '', true)`);
	await onBody(tab);
});

test('the page zoomed: views follow in the window, not in its CSS pixels', async () => {
	const [left] = await panes();
	const tab = left!.active;
	await onBody(tab);
	await app.eval(`host.webview.setZoom(1.25)`);
	await until(async () => {
		const [v, b] = await Promise.all([bounds(tab), body(left!.id)]);
		return Math.abs(v.x - b.x * 1.25) <= 2 && Math.abs(v.width - b.width * 1.25) <= 2 && Math.abs(v.height - b.height * 1.25) <= 2;
	}, 'scaled');
	await app.eval(`host.webview.setZoom(1)`);
	await onBody(tab);
	// Zoomed by what the page's code doesn't see (a menu's zoom role acts on the view natively).
	await app.platform('webview', 'setZoom', { zoom: 1.25, windowId: 0 });
	await until(async () => {
		const [v, b] = await Promise.all([bounds(tab), body(left!.id)]);
		return Math.abs(v.width - b.width * 1.25) <= 2;
	}, 'scaled, seen from the page');
	await app.platform('webview', 'setZoom', { zoom: 1, windowId: 0 });
	await onBody(tab);
});

test('panes moving inside their root, the root staying put: the views follow', async () => {
	const [left] = await panes();
	const tab = left!.active;
	await onBody(tab);
	const root = `document.querySelector('[data-sd-panes]')`;
	const was = await bounds(tab);
	await app.eval(`(${root}.style.paddingLeft = '20px', ${root}.style.paddingRight = '0', true)`);
	await until(async () => (await bounds(tab)).x > was.x, 'moved', 4000);
	await onBody(tab);
	await app.eval(`(${root}.style.paddingLeft = '', ${root}.style.paddingRight = '', true)`);
	await onBody(tab);
});

test('the window resized while dragging a boundary: the minimum is the one at the new size', async () => {
	const [left, right] = await panes();
	const line = (code: string) => app.eval(`(() => {
		const el = document.querySelector('[data-sd-splitter]');
		const at = (type, dx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, button: 0, clientX: window.__press + dx, clientY: 200 }));
		${code}
		return true;
	})()`);
	const share = await app.eval<number>(`window.__tabs.panes.root.sizes[0]`);
	await line(`window.__press = el.getBoundingClientRect().left; at('pointerdown', 0); at('pointermove', 1);`);
	const { bounds: was } = await app.platform<{ bounds: Box }>('window', 'getInfo');
	await app.platform('window', 'setBounds', { ...was, width: 900 });
	await until(() => app.eval<boolean>(`innerWidth === 900`), 'narrower');
	await Bun.sleep(100);
	await line(`at('pointermove', 5000);`);
	await until(async () => (await bounds(right!.active)).width <= 182, 'the right one at its minimum');
	expect((await bounds(right!.active)).width).toBeGreaterThanOrEqual(179);
	await line(`at('pointermove', 2); dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
	await until(() => app.eval<boolean>(`!document.querySelector('[data-sd-splitter]').hasAttribute('data-dragging')`), 'canceled');
	await until(async () => (await bounds(left!.active)).width >= 179 && (await bounds(right!.active)).width >= 179, 'within the minimum');
	// Canceled: the share it had when the press came, not one from the drag.
	expect(Math.abs((await app.eval<number>(`window.__tabs.panes.root.sizes[0]`)) - share)).toBeLessThan(0.01);
	await app.platform('window', 'setBounds', was);
	await app.eval(`(document.querySelector('[data-sd-splitter]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true)`);
	await onBody(left!.active);
});

test('a padded root: its edge still reaches a whole side', async () => {
	const [left] = await panes();
	const root = `document.querySelector('[data-sd-panes]')`;
	await app.eval(`(${root}.style.padding = '24px', true)`);
	const r = await app.eval<Box>(`(() => { const r = ${root}.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
	await dragTab(left!.tabs[0]!, { x: r.x + 8, y: r.y + 200 }, { release: false });
	await until(() => app.eval<boolean>(`document.querySelector('[data-sd-pane-drop-root]')?.getAttribute('data-sd-pane-drop') === 'left'`), 'the left side');
	await app.eval(`(dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
	await app.eval(`(${root}.style.padding = '', true)`);
	await onBody(left!.active);
});

test('your code removes the active tab: what its pane shows next is the active one', async () => {
	const [left] = await panes();
	const made = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/threads/6', { pane: '${left!.id}', reuse: false }).id }))()`);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${made.id}'`), 'active');
	await app.eval(`(window.__tabs.items = window.__tabs.items.filter((t) => t.id !== '${made.id}'), true)`);
	await until(() => app.eval<boolean>(`!!window.__tabs.active && window.__tabs.active.id === window.__tabs.panes.focused.active`), 'the next one');
	expect(await app.eval(`window.__tabs.get('${made.id}') === undefined`)).toBe(true);
});

test('a link in the window its page cancels: the tab says where it really is', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	const at = await inView<string>(tab, 'location.pathname');
	await inView(tab, `(window.__stop = globalThis.__desktopBeforeNavigate((nav) => nav.cancel()), true)`);
	await app.eval(`(document.querySelector('.sidebar a[href="/threads/4"]').click(), true)`);
	await Bun.sleep(300);
	expect(await inView<string>(tab, 'location.pathname')).toBe(at);
	expect((await items()).find((t) => t.id === tab)?.path).toBe(at);
	// And the same link works once it stops canceling.
	await inView(tab, `(window.__stop(), true)`);
	await app.eval(`(document.querySelector('.sidebar a[href="/threads/4"]').click(), true)`);
	await until(async () => (await items()).find((t) => t.id === tab)?.path === '/threads/4', 'there');
	expect(await inView<string>(tab, 'location.pathname')).toBe('/threads/4');
});

test('every link of the sidebar goes there, back to the page the window started on included', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	const hrefs = await app.eval<string[]>(`[...document.querySelectorAll('.sidebar a[href]')].map((a) => a.getAttribute('href'))`);
	expect(hrefs).toContain('/');
	for (const href of [...hrefs.filter((h) => h !== '/live'), '/threads/1', '/', '/threads/2', '/threads/2'.replace('2', '1')]) {
		await app.eval(`(() => { const a = document.querySelector('.sidebar a[href="${href}"]'); a.click(); return true; })()`);
		await until(async () => (await inView<string>(tab, 'location.pathname')) === href, `the view at ${href}`);
		await until(async () => (await items()).find((t) => t.id === tab)?.path === href, `the tab at ${href}`);
		await until(() => app.eval<boolean>(`location.pathname === ${JSON.stringify(href)}`), `the window at ${href}`);
	}
});

test('a route id with a matcher: only what it matches has its own tab', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	const count = (await items()).length;
	// From a view: /numbers/new is a route of its own, /numbers/1 the kept one.
	await inView(tab, `(globalThis.__desktopGoto('/numbers/new'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/numbers/new', 'it went');
	expect((await items()).length).toBe(count);
	await inView(tab, `(globalThis.__desktopGoto('/numbers/1'), true)`);
	await until(async () => (await items()).some((t) => t.path === '/numbers/1'), 'its own tab');
	expect(await inView<string>(tab, 'location.pathname')).toBe('/numbers/new');
	await app.eval(`(window.__tabs.close(window.__tabs.items.find((t) => t.path === '/numbers/1').id), true)`);
	// From the window: the same.
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	await app.eval(`(() => { const a = document.createElement('a'); a.href = '/threads/1'; document.querySelector('.sidebar').append(a); a.click(); a.remove(); return true; })()`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/1', 'back on a thread');
	await app.eval(`(() => { const a = document.createElement('a'); a.href = '/numbers/new'; document.querySelector('.sidebar').append(a); a.click(); a.remove(); return true; })()`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/numbers/new', 'the link moved this tab');
	expect((await items()).length).toBe(count);
	await inView(tab, `(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(async () => (await items()).find((t) => t.id === tab)?.path === '/threads/1', 'on a thread');
});

test('goto() in the window with its options: they reach the page in the pane', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	const length = await inView<number>(tab, 'history.length');
	await app.eval(`(globalThis.__desktopGoto('/threads/2', { replace: true, state: { selected: '42', when: new Date(86400000) } }), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/2', 'there');
	// As SvelteKit keeps it: a Date stays one in the other process.
	expect(await inView(tab, `(() => { const s = globalThis.__desktopEntryState(); return [s.selected, s.when instanceof Date, +s.when]; })()`)).toEqual(['42', true, 86400000]);
	expect(await inView<number>(tab, 'history.length')).toBe(length);
	// To the address it's at, with a state: that's a navigation too.
	await until(async () => (await items()).find((t) => t.id === tab)?.path === '/threads/2', 'reported');
	await app.eval(`(globalThis.__desktopGoto('/threads/2', { state: { selected: '43' } }), true)`);
	await until(() => inView<boolean>(tab, `globalThis.__desktopEntryState().selected === '43'`), 'the new state');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/1', 'back');
});

test("another state at the same address: an empty one, back and forward too; a shallow one keeps the pane's page", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	const selected = (value: unknown) => until(() => inView<boolean>(tab, `globalThis.__desktopEntryState()?.selected === ${JSON.stringify(value)}`), `selected ${value}`);
	await app.eval(`(globalThis.__desktopGoto('/threads/2'), true)`);
	await until(async () => (await items()).find((t) => t.id === tab)?.path === '/threads/2', 'there');
	await app.eval(`(globalThis.__desktopGoto('/threads/2', { state: { selected: 1 } }), true)`);
	await selected(1);
	await app.eval(`(globalThis.__desktopGoto('/threads/2', { state: { selected: 2 } }), true)`);
	await selected(2);
	await app.eval(`(history.back(), true)`);
	await selected(1);
	await app.eval(`(history.forward(), true)`);
	await selected(2);
	await app.eval(`(globalThis.__desktopGoto('/threads/2', { state: {} }), true)`);
	await until(() => inView<boolean>(tab, `globalThis.__desktopEntryState()?.selected === undefined`), 'the state cleared');
	// Shallow: an entry with the page's URL in it, the page stays.
	await inView(tab, `(globalThis.__sameDocument = document.querySelector('[data-alive]'), true)`);
	await app.eval(`(globalThis.__desktopGoto('/threads/2', { shallow: true, state: { modal: true } }), true)`);
	await until(() => inView<boolean>(tab, `globalThis.__desktopEntryState()?.modal === true`), 'the state');
	expect(await inView(tab, `globalThis.__desktopEntryOptions().shallow === true && document.querySelector('[data-alive]') === globalThis.__sameDocument`)).toBe(true);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/1', 'back');
});

test('back into a shallow entry: its page first, the address stays', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/2'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/2', 'at the second');
	await app.eval(`(globalThis.__desktopGoto('/threads/2?modal=1', { shallow: true, state: { modal: 1 } }), true)`);
	await until(() => inView<boolean>(tab, `location.search === '?modal=1'`), 'the shallow address');
	expect(await inView(tab, `globalThis.__desktopPageUrl()`)).toBe('/threads/2');
	await until(() => app.eval<boolean>(`location.search === '?modal=1'`), "the window's stays");
	await app.eval(`(globalThis.__desktopGoto('/threads/3'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/3' && globalThis.__desktopPageUrl() === '/threads/3'`), 'at the third');
	await app.eval(`(history.back(), true)`);
	await until(() => inView<boolean>(tab, `location.search === '?modal=1' && globalThis.__desktopPageUrl() === '/threads/2' && globalThis.__desktopEntryState()?.modal === 1`), 'the entry, on its page');
	// The window's history as it was: the entry is still the shallow one, and forward is still there.
	await Bun.sleep(200);
	expect(await app.eval(`[location.search, globalThis.__desktopEntryOptions().shallow]`)).toEqual(['?modal=1', true]);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/1', 'back');
});

test("an open kept route's tab: an empty state clears its state, and coming back calls off where it was going", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/live/kept-state').id`);
	await drawn(id);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${id}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/live/kept-state', { state: { selected: 1 } }), true)`);
	await until(() => inView<boolean>(id, `globalThis.__desktopEntryState()?.selected === 1`), 'its state');
	await app.eval(`(globalThis.__desktopGoto('/live/kept-state', { state: {} }), true)`);
	await until(() => inView<boolean>(id, `globalThis.__desktopEntryState()?.selected === undefined`), 'cleared');
	await click('/slow', '/live/kept-state');
	await Bun.sleep(1200); // /slow takes 700 ms
	expect(await inView<string>(id, 'location.pathname')).toBe('/live/kept-state');
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test("a link out of the app in a pane's page: SvelteKit goes on calling beforeNavigate after it", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/threads/1').id`);
	await drawn(id);
	// An SVG link SvelteKit takes for a link out of the app, to an address nothing opens (shell.openExternal refuses its scheme).
	await inView(id, `(() => {
		const a = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		a.setAttribute('href', 'x-sd-nothing://here');
		document.body.append(a);
		a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		a.remove();
		return true;
	})()`);
	await Bun.sleep(100);
	// Its beforeNavigate still takes a kept route to that route's tab.
	await inView(id, `(globalThis.__desktopGoto('/live/after-a-link-out'), true)`);
	await until(async () => (await items()).some((t) => t.path === '/live/after-a-link-out'), "the route's tab");
	expect(await inView<string>(id, 'location.pathname')).toBe('/threads/1');
	const kept = (await items()).find((t) => t.path === '/live/after-a-link-out')!.id;
	await app.eval(`(window.__tabs.close('${kept}'), window.__tabs.close('${id}'), true)`);
});

test("a goto() in the window its page cancels: the window's entry goes, no trap for Back", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await Bun.sleep(100);
	const length = await app.eval<number>('history.length');
	const state = JSON.stringify(await app.eval('history.state'));
	await inView(tab, `(globalThis.__stop = __desktopBeforeNavigate((nav) => nav.cancel()), true)`);
	await app.eval(`(globalThis.__desktopGoto('/threads/2'), true)`);
	await until(() => app.eval<boolean>(`history.length === ${length + 1}`), "the window's entry");
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1'`), 'taken back');
	await Bun.sleep(200);
	expect(await app.eval('history.length')).toBe(length + 1); // not one more for where it stayed
	expect(JSON.stringify(await app.eval('history.state'))).toBe(state);
	expect(await inView<string>(tab, 'location.pathname')).toBe('/threads/1');
	await inView(tab, `(globalThis.__stop(), true)`);
});

test("what the page cancels, whatever the window did for it: its history as it was", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	const at = (path: string) => until(() => app.eval<boolean>(`location.pathname === '${path}' && window.__tabs.get('${tab}').path === '${path}'`), `at ${path}`);
	for (const n of [1, 2, 3]) {
		await app.eval(`(globalThis.__desktopGoto('/threads/${n}'), true)`);
		await at(`/threads/${n}`);
	}
	await app.eval(`(history.back(), true)`);
	await at('/threads/2');
	await Bun.sleep(100);
	const length = await app.eval<number>('history.length');
	const state = JSON.stringify(await app.eval('history.state'));
	await inView(tab, `(globalThis.__stop = __desktopBeforeNavigate((nav) => nav.cancel()), true)`);
	const asBefore = async () => {
		await until(() => app.eval<boolean>(`location.pathname === '/threads/2'`), 'back at the second');
		await Bun.sleep(200);
		expect(await app.eval('location.pathname')).toBe('/threads/2');
		expect(JSON.stringify(await app.eval('history.state'))).toBe(state);
		expect(await inView<string>(tab, 'location.pathname')).toBe('/threads/2');
	};
	// Back: the entries after it stay, and its state.
	await app.eval(`(history.back(), true)`);
	await asBefore();
	expect(await app.eval('history.length')).toBe(length);
	// A replace: the entry it replaced.
	await app.eval(`(globalThis.__desktopGoto('/threads/4', { replace: true }), true)`);
	await asBefore();
	expect(await app.eval('history.length')).toBe(length);
	// Taking it back isn't SvelteKit's to cancel: a beforeNavigate in the window's page doesn't get a say.
	await app.eval(`(globalThis.__guard = __desktopBeforeNavigate((nav) => { if (nav.type === 'popstate') { globalThis.__guarded = true; nav.cancel(); } }), true)`);
	await app.eval(`(globalThis.__desktopGoto('/threads/4'), true)`);
	await asBefore();
	expect(await app.eval('globalThis.__guarded ?? false')).toBe(false);
	await app.eval(`(globalThis.__guard(), true)`);
	await inView(tab, `(globalThis.__stop(), true)`);
	// The entries after it are there: forward goes to them.
	await app.eval(`(history.forward(), true)`);
	await at('/threads/4');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await at('/threads/1');
});

test('the same address with a state its page cancels: the state and the entry go', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await Bun.sleep(100);
	const state = JSON.stringify(await app.eval('history.state'));
	await inView(tab, `(globalThis.__stop = __desktopBeforeNavigate((nav) => nav.cancel()), true)`);
	await app.eval(`(globalThis.__desktopGoto('/threads/1', { state: { selected: 42 } }), true)`);
	await until(async () => JSON.stringify(await app.eval('history.state')) === state, 'as it was');
	expect(await app.eval('window.__pageState()')).toEqual({});
	await inView(tab, `(globalThis.__stop(), true)`);
});

test('from a fragment of the window, unnumbered: what its page cancels is no reload', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__draft = 'still here', location.hash = '#unnumbered', true)`);
	await until(() => inView<boolean>(tab, `location.hash === '#unnumbered'`), 'the fragment');
	await app.eval(`(globalThis.__desktopGoto('/threads/2'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/2'`), 'at the second');
	await app.eval(`(history.back(), true)`);
	await until(() => app.eval<boolean>(`location.hash === '#unnumbered'`), 'back on it');
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1'`), 'its page too');
	await inView(tab, `(globalThis.__stop = __desktopBeforeNavigate((nav) => nav.cancel()), true)`);
	await app.eval(`(history.forward(), true)`);
	await Bun.sleep(400);
	expect(await app.eval('globalThis.__draft')).toBe('still here');
	expect(await inView<string>(tab, 'location.pathname')).toBe('/threads/1');
	await inView(tab, `(globalThis.__stop(), true)`);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1' && location.hash === ''`), 'away from it');
});

test("a link in the window its handler cancels: nothing moves; a plain one is followed", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	const follow = (handler: string) =>
		app.eval(`(() => {
			const a = Object.assign(document.createElement('a'), { href: '/threads/2' });
			a.addEventListener('click', ${handler});
			document.body.append(a);
			a.click();
			a.remove();
			return true;
		})()`);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1'`), 'at the first');
	await follow(`(e) => e.preventDefault()`);
	await Bun.sleep(300);
	expect(await inView<string>(tab, 'location.pathname')).toBe('/threads/1');
	await app.eval(`(() => {
		const a = Object.assign(document.createElement('a'), { href: '/threads/2' });
		document.body.append(a);
		a.click();
		a.remove();
		return true;
	})()`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/2'`), 'a plain one followed');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1'`), 'back');
});

test('a link in the window to where the tab is: its loads run again', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await inView(tab, `(() => { const g = globalThis.__desktopGoto; globalThis.__asked = []; globalThis.__restore = () => (globalThis.__desktopGoto = g); globalThis.__desktopGoto = (u, o) => (__asked.push(o), g(u, o)); return true; })()`);
	const here = (await items()).find((t) => t.id === tab)!.path!;
	await click(here);
	await until(async () => (await inView<unknown[]>(tab, '__asked')).length === 1, 'asked');
	expect(await inView(tab, '__asked[0]')).toMatchObject({ refreshAll: true, replace: true });
	await inView(tab, `(__restore(), true)`);
});

test("links in the window with data-sveltekit-replacestate: one entry in the window's history and in the page's", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await Bun.sleep(100);
	const lengths = async () => [await app.eval<number>('history.length'), await inView<number>(tab, 'history.length')];
	const before = await lengths();
	for (const n of [1, 2]) {
		await app.eval(`(() => {
			const a = Object.assign(document.createElement('a'), { href: '/threads/1?filter=${n}' });
			a.setAttribute('data-sveltekit-replacestate', '');
			document.body.append(a);
			a.click();
			a.remove();
			return true;
		})()`);
		await until(() => app.eval<boolean>(`location.search === '?filter=${n}'`), `filter ${n}`);
		await until(() => inView<boolean>(tab, `location.search === '?filter=${n}'`), `its page, filter ${n}`);
	}
	expect(await lengths()).toEqual(before);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.search === ''`), 'back');
});

test('goto(here, { refreshAll: true }) in the window: the page on screen is asked too', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	const here = (await items()).find((t) => t.id === tab)!.path!;
	await until(() => app.eval<boolean>(`location.pathname + location.search + location.hash === ${JSON.stringify(here)}`), 'the address');
	await inView(tab, `(() => { const g = globalThis.__desktopGoto; globalThis.__asked = []; globalThis.__restore = () => (globalThis.__desktopGoto = g); globalThis.__desktopGoto = (u, o) => (__asked.push(o), g(u, o)); return true; })()`);
	await app.eval(`(globalThis.__desktopGoto(${JSON.stringify(here)}, { refreshAll: true }), true)`);
	await until(async () => (await inView<unknown[]>(tab, '__asked')).length === 1, 'asked');
	expect(await inView(tab, '__asked[0]')).toMatchObject({ refreshAll: true });
	await inView(tab, `(__restore(), true)`);
});

test("a kept route's open tab cancelling a goto() with a state: the window's entry goes", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/live/cancels').id`);
	await drawn(id);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${id}' && location.pathname === '/live/cancels'`), 'in focus');
	await Bun.sleep(100);
	const state = JSON.stringify(await app.eval('history.state'));
	await inView(id, `(globalThis.__stop = __desktopBeforeNavigate((nav) => nav.cancel()), true)`);
	await app.eval(`(globalThis.__desktopGoto('/live/cancels', { state: { selected: 42 } }), true)`);
	await until(async () => JSON.stringify(await app.eval('history.state')) === state, 'as it was');
	expect(await app.eval('window.__pageState()')).toEqual({});
	await inView(id, `(globalThis.__stop(), true)`);
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test("a goto() in a pane's page to a kept route: its tab gets the state", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/threads/1', { reuse: false }).id`);
	await drawn(id);
	await inView(id, `(globalThis.__desktopGoto('/live/given-state', { state: { selected: '42' } }), true)`);
	await until(async () => (await items()).some((t) => t.path === '/live/given-state'), 'its tab');
	const kept = (await items()).find((t) => t.path === '/live/given-state')!.id;
	await until(() => inView<boolean>(kept, `globalThis.__desktopEntryState?.()?.selected === '42'`), 'its state');
	await app.eval(`(window.__tabs.close('${kept}'), window.__tabs.close('${id}'), true)`);
});

test("a link with target=_blank in a pane's page its handler cancels: no tab", async () => {
	const pane = (await panes())[1]!;
	const tab = pane.active;
	const count = (await items()).length;
	await inView(tab, `(() => {
		const a = Object.assign(document.createElement('a'), { href: '/threads/9', target: '_blank' });
		a.addEventListener('click', (e) => e.preventDefault());
		document.body.append(a);
		a.click();
		a.remove();
		return true;
	})()`);
	await Bun.sleep(300);
	expect((await items()).length).toBe(count);
});

test("the app's menu replaced: the tab menu goes in the new one, its shortcuts stay", async () => {
	const pane = (await panes())[1]!;
	await inView(pane.active, `host.menu.setAppMenu([{ label: 'Replaced', items: [{ id: 'mine', label: 'Mine' }] }])`);
	await until(() => app.platform('menu', 'get', { id: 'tabs:new' }).then((item) => !!item), 'the tab menu');
});

test('links to where the tab is with data-sveltekit-replacestate: its loads run again too', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await inView(tab, `(() => { const g = globalThis.__desktopGoto; globalThis.__asked = []; globalThis.__restore = () => (globalThis.__desktopGoto = g); globalThis.__desktopGoto = (u, o) => (__asked.push(o), g(u, o)); return true; })()`);
	const here = (await items()).find((t) => t.id === tab)!.path!;
	await app.eval(`(() => {
		const a = Object.assign(document.createElement('a'), { href: ${JSON.stringify(here)} });
		a.setAttribute('data-sveltekit-replacestate', '');
		document.body.append(a);
		a.click();
		a.remove();
		return true;
	})()`);
	await until(async () => (await inView<unknown[]>(tab, '__asked')).length === 1, 'asked');
	expect(await inView(tab, '__asked[0]')).toMatchObject({ refreshAll: true, replace: true });
	await inView(tab, `(__restore(), true)`);
});

test('a shallow goto() in the window: a taken one stays, not taken for canceled', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await Bun.sleep(100);
	await app.eval(`(globalThis.__desktopGoto('/threads/1', { shallow: true, state: { modal: true } }), true)`);
	await until(() => inView<boolean>(tab, `globalThis.__desktopEntryState()?.modal === true`), 'taken');
	await Bun.sleep(200);
	expect(await app.eval(`globalThis.__desktopEntryState()?.modal`)).toBe(true);
	await app.eval(`(history.back(), true)`);
	await until(() => inView<boolean>(tab, `globalThis.__desktopEntryState()?.modal === undefined`), 'back');
});

test("a goto() with a state, then a kept route reached otherwise: last goto()'s state isn't its", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/threads/1', { reuse: false }).id`);
	await drawn(id);
	await inView(id, `(globalThis.__desktopGoto('/threads/2', { state: { old: true } }), true)`);
	await until(() => inView<boolean>(id, `location.pathname === '/threads/2'`), 'there');
	await inView(id, `(document.body.append(Object.assign(document.createElement('a'), { href: '/live/no-state', id: 'kept' })), document.getElementById('kept').click(), document.getElementById('kept').remove(), true)`);
	await until(async () => (await items()).some((t) => t.path === '/live/no-state'), 'its tab');
	const kept = (await items()).find((t) => t.path === '/live/no-state')!.id;
	await drawn(kept);
	await Bun.sleep(200);
	expect(await inView(kept, `globalThis.__desktopEntryState?.()?.old ?? null`)).toBe(null);
	await app.eval(`(window.__tabs.close('${kept}'), window.__tabs.close('${id}'), true)`);
});

test("a link to where a kept route's tab is: its loads run again", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/live/refreshed').id`);
	await drawn(id);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${id}'`), 'in focus');
	await inView(id, `(() => { const g = globalThis.__desktopGoto; globalThis.__asked = []; globalThis.__desktopGoto = (u, o) => (__asked.push(o), g(u, o)); return true; })()`);
	await click('/live/refreshed');
	await until(async () => (await inView<unknown[]>(id, '__asked')).length === 1, 'asked');
	expect(await inView(id, '__asked[0]')).toMatchObject({ refreshAll: true });
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test("a view's page asks where it is: the window it's in, and the view", async () => {
	const pane = (await panes())[1]!;
	const info = await inView<{ windowId: number; viewId?: string }>(pane.active, `host.webview.getInfo()`);
	expect(info.viewId).toBe(viewId(pane.active));
	expect(await inView(pane.active, `host.windows.getInfo(${info.windowId}).then((w) => w.label, () => 'none')`)).toBe('main');
});

test("a link with data-sveltekit-reload to a kept route's tab: a load of that tab", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/live/reloaded').id`);
	await drawn(id);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${id}'`), 'in focus');
	await inView(id, `(globalThis.__sameDocument = true, true)`);
	await app.eval(`(() => {
		const a = Object.assign(document.createElement('a'), { href: '/live/reloaded' });
		a.setAttribute('data-sveltekit-reload', '');
		document.body.append(a);
		a.click();
		a.remove();
		return true;
	})()`);
	await until(() => inView<boolean>(id, `globalThis.__sameDocument === undefined && !!document.querySelector('[data-alive]')`), 'loaded again');
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test("host.webview's target from getInfo: that view, not its window", async () => {
	const [first, second] = await panes();
	await inView(first!.active, `(globalThis.__draft = 'mine', true)`);
	await inView(second!.active, `(globalThis.__draft = 'mine', true)`);
	await app.eval(`(globalThis.__draft = 'mine', true)`);
	const info = await inView<{ viewId: string; windowId: number }>(second!.active, `host.webview.getInfo()`);
	await inView(first!.active, `(host.webview.reload(${JSON.stringify(info)}), true)`);
	await until(() => inView<boolean>(second!.active, `globalThis.__draft === undefined && !!document.querySelector('[data-alive]')`), 'reloaded');
	expect(await inView(first!.active, `globalThis.__draft`)).toBe('mine');
	expect(await app.eval(`globalThis.__draft`)).toBe('mine');
});

test("a click on a pane's notification: its tab on screen, not when dismissed or quiet", async () => {
	const pane = (await panes())[1]!;
	const tab = pane.active;
	const other = await app.eval<string>(`window.__tabs.open('/threads/5', { pane: '${pane.id}', reuse: false }).id`);
	await until(async () => (await panes())[1]!.active === other, 'another tab on screen');
	let seq = 900_000 + Math.floor(Math.random() * 1000);
	const respond = (extra: object) =>
		app.eval(`(window.__shell.deliver('notificationResponse', ${JSON.stringify({ seq: ++seq, id: 'n', target: true, ...extra, payload: JSON.stringify({ view: viewId(tab), quiet: ['later'] }) })}), true)`);
	await respond({ kind: 'dismiss' });
	await respond({ kind: 'action', actionId: 'later' });
	await Bun.sleep(100);
	expect((await panes())[1]!.active).toBe(other);
	await respond({ kind: 'click' });
	await until(async () => (await panes())[1]!.active === tab, 'its tab');
	await app.eval(`(window.__tabs.close('${other}'), true)`);
});

test("a link with data-sveltekit-reload to a static route beside a kept one: a load of this tab, no new one", async () => {
	const id = await app.eval<string>(`window.__tabs.open('/threads/1', { reuse: false }).id`);
	await drawn(id);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${id}'`), 'in focus');
	const count = (await items()).length;
	await app.eval(`(() => {
		const a = Object.assign(document.createElement('a'), { href: '/numbers/new' });
		a.setAttribute('data-sveltekit-reload', '');
		document.body.append(a);
		a.click();
		a.remove();
		return true;
	})()`);
	await until(async () => (await inView<string>(id, 'location.pathname')) === '/numbers/new', 'there');
	expect((await items()).length).toBe(count);
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test("a tab's page is its window's: inspectable if the window's is", async () => {
	const pane = (await panes())[1]!;
	const [win, view] = await Promise.all([app.eval<{ inspectable?: boolean }>(`host.webview.getInfo()`), inView<{ inspectable?: boolean }>(pane.active, `host.webview.getInfo()`)]);
	if ('inspectable' in win) expect(view.inspectable).toBe(win.inspectable);
});

test("a view's page is the size of its pane, after a resize too", async () => {
	const [first, second] = await panes();
	for (const pane of [first!, second!]) {
		const tab = pane.active;
		await until(async () => {
			const [b, inner] = await Promise.all([bounds(tab), inView<[number, number]>(tab, '[innerWidth, innerHeight]')]);
			return inner[0] === b.width && inner[1] === b.height;
		}, `the page of ${tab}: ${JSON.stringify(await bounds(tab))} ${JSON.stringify(await inView(tab, '[innerWidth, innerHeight]'))}`, 3000);
	}
});

test('the direction changing with the language, no resize: the panes know', async () => {
	await app.eval(`(document.documentElement.dir = 'rtl', true)`);
	await until(() => app.eval<boolean>(`window.__tabs.panes.rtl === true`), 'right to left');
	await app.eval(`(document.documentElement.dir = '', true)`);
	await until(() => app.eval<boolean>(`window.__tabs.panes.rtl === false`), 'left to right');
});

test('a link with target="_self" in the window: a load of the tab, not of the window', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await inView(tab, `(globalThis.__sameDocument = true, true)`);
	await app.eval(`(globalThis.__draft = 'still here', true)`);
	const path = (await items()).find((t) => t.id === tab)!.path!;
	await app.eval(`(() => {
		const a = Object.assign(document.createElement('a'), { href: ${JSON.stringify(path)}, target: '_self' });
		document.body.append(a);
		a.click();
		a.remove();
		return true;
	})()`);
	await until(() => inView<boolean>(tab, `globalThis.__sameDocument === undefined && !!document.querySelector('[data-alive]')`), 'loaded again');
	expect(await app.eval('globalThis.__draft')).toBe('still here');
});

test('a link in the window with data-sveltekit-reload: a load of the tab, at the address it is at too', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await inView(tab, `(globalThis.__sameDocument = true, true)`);
	const path = await inView<string>(tab, 'location.pathname');
	await app.eval(`(() => {
		const a = Object.assign(document.createElement('a'), { href: '${path}' });
		a.setAttribute('data-sveltekit-reload', '');
		document.body.append(a);
		a.click();
		a.remove();
		return true;
	})()`);
	await until(() => inView<boolean>(tab, `globalThis.__sameDocument === undefined && !!document.querySelector('[data-alive]')`), 'loaded again');
	expect(await inView<string>(tab, 'location.pathname')).toBe(path);
});

test("the keyboard reaching another pane's bar: that pane is the one the keys are about", async () => {
	const [first, second] = await panes();
	await app.eval(`(window.__tabs.focus('${first!.id}'), true)`);
	await until(async () => (await panes()).find((p) => p.id === first!.id)!.focused, 'the first in focus');
	await app.eval(`(() => {
		const el = document.createElement('span');
		el.setAttribute('data-sd-splitter', '');
		document.querySelector('[data-sd-pane="${second!.id}"]').append(el);
		el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		el.remove();
		return true;
	})()`);
	await until(async () => (await panes()).find((p) => p.id === second!.id)!.focused, 'the second in focus');
	expect(await app.eval(`window.__tabs.pageKeyboard`)).toBe(true);
});

test("a shallow entry whose page is canceled: not applied over another page", async () => {
	const pane = (await panes())[1]!;
	const tab = pane.active;
	await inView(tab, `(globalThis.__stop = __desktopBeforeNavigate((nav) => { if (!nav.to?.url.search) nav.cancel(); }), true)`);
	await inView(tab, `globalThis.__desktopGoto('/threads/2?modal=1', { shallow: true, pageUrl: location.origin + '/threads/2', stateJson: '[{}]' }).then(() => true)`);
	expect(await inView<string>(tab, 'location.pathname + location.search')).toBe('/threads/1');
	await inView(tab, `(globalThis.__stop(), true)`);
});

test("a link to a fragment in a pane's page: its tab and the address have it", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await inView(tab, `(() => { const a = Object.assign(document.createElement('a'), { href: '#section' }); document.body.append(a); a.click(); a.remove(); return true; })()`);
	await until(async () => (await items()).find((t) => t.id === tab)?.path === '/threads/1#section', 'its tab');
	await until(() => app.eval<boolean>(`location.hash === '#section'`), 'the address');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.hash === ''`), 'back');
});

test('a link in the window to what has no page (a file, an endpoint): loaded in the tab', async () => {
	const id = await app.eval<string>(`window.__tabs.open('/threads/1').id`);
	await drawn(id);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${id}'`), 'in focus');
	await click('/hello.txt');
	await until(async () => (await inView<string>(id, 'location.pathname')) === '/hello.txt', 'there');
	expect(await inView<string>(id, 'document.body.textContent')).toContain('hello');
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test("shallow in the page, then shallow from the window: the page stays mounted", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await inView(tab, `(globalThis.__sameDocument = document.querySelector('[data-alive]'), globalThis.__desktopGoto('/threads/1?inner=1', { shallow: true, state: { a: 1 } }), true)`);
	await until(() => app.eval<boolean>(`location.search === '?inner=1'`), "the window's address");
	await app.eval(`(globalThis.__desktopGoto('/threads/1', { shallow: true, state: { b: 1 } }), true)`);
	await until(() => inView<boolean>(tab, `globalThis.__desktopEntryState()?.b === 1`), 'the state');
	expect(await inView(tab, `[globalThis.__desktopPageUrl(), document.querySelector('[data-alive]') === globalThis.__sameDocument]`)).toEqual(['/threads/1', true]);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `globalThis.__desktopEntryState()?.b === undefined`), 'back');
});

test("a shallow entry of the page's own, Back in the window to it: its page, its state", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await inView(tab, `(globalThis.__desktopGoto('/threads/2', { shallow: true, state: { modal: true } }), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/2'`), "the window's address");
	await click('/threads/3');
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/3' && globalThis.__desktopPageUrl() === '/threads/3'`), 'at the third');
	await until(() => app.eval<boolean>(`location.pathname === '/threads/3'`), "the window's address again");
	await app.eval(`(history.back(), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/2' && globalThis.__desktopPageUrl() === '/threads/1' && globalThis.__desktopEntryState()?.modal === true`), 'the entry, on its page');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1'`), 'back');
});

test("a page's own history, as the window's: a replace replaces, a state comes back, a new state is an entry", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await Bun.sleep(100);
	const length = await app.eval<number>('history.length');
	await inView(tab, `(globalThis.__desktopGoto('/threads/2', { replace: true }), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/2'`), 'the address');
	await Bun.sleep(100);
	expect(await app.eval('history.length')).toBe(length); // replaced, not one more
	await inView(tab, `(globalThis.__desktopGoto('/threads/4', { state: { selected: '42' } }), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/4'`), 'the fourth');
	await inView(tab, `(globalThis.__desktopGoto('/threads/4', { shallow: true, state: { modal: true } }), true)`);
	await until(() => app.eval<boolean>(`globalThis.__desktopEntryOptions().stateJson?.includes('modal') === true`), 'a state of its own');
	await app.eval(`(history.back(), true)`);
	await until(() => inView<boolean>(tab, `globalThis.__desktopEntryState()?.selected === '42'`), 'its state again');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1'`), 'back');
});

test("focus away and back: Back in the window still has the page's state", async () => {
	const [first, second] = await panes();
	await app.eval(`(window.__tabs.focus('${second!.id}'), true)`);
	const tab = second!.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await inView(tab, `(globalThis.__desktopGoto('/threads/2', { state: { selected: 'b' } }), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/2'`), 'there');
	await until(() => app.eval<boolean>(`globalThis.__desktopEntryOptions().stateJson?.includes('selected') === true`), 'its entry');
	await app.eval(`(window.__tabs.focus('${first!.id}'), true)`);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${first!.active}'`), 'the other');
	await app.eval(`(window.__tabs.focus('${second!.id}'), true)`);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}' && location.pathname === '/threads/2'`), 'back in focus');
	await until(() => app.eval<boolean>(`globalThis.__desktopEntryOptions().stateJson?.includes('selected') === true`), 'its entry again');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1'`), 'elsewhere');
});

test('Back in the window: the page scrolled where it was', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await inView(tab, `(document.documentElement.style.height = '4000px', scrollTo(0, 800), true)`);
	await until(() => inView<boolean>(tab, `scrollY === 800`), 'scrolled');
	await app.eval(`(globalThis.__desktopGoto('/threads/2'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/2' && scrollY === 0`), 'at the second, at its top');
	await app.eval(`(history.back(), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1' && scrollY === 800`), 'scrolled again');
	await inView(tab, `(document.documentElement.style.height = '', true)`);
});

test("a link to a fragment in the page: a new entry, Back in the window comes back from it", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && location.hash === '' && window.__tabs.get('${tab}').path === '/threads/1'`), 'at the first');
	await Bun.sleep(100);
	const length = await app.eval<number>('history.length');
	await inView(tab, `(() => { const a = Object.assign(document.createElement('a'), { href: '#details' }); document.body.append(a); a.click(); a.remove(); return true; })()`);
	await until(() => app.eval<boolean>(`location.hash === '#details'`), 'the address');
	await Bun.sleep(100);
	expect(await app.eval('history.length')).toBe(length + 1);
	await app.eval(`(history.back(), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/threads/1' && location.hash === ''`), 'back on it');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.hash === ''`), 'without it');
});

test("goto()'s other options reach the page", async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await inView(tab, `(() => { const g = globalThis.__desktopGoto; globalThis.__asked = []; globalThis.__restore = () => (globalThis.__desktopGoto = g); globalThis.__desktopGoto = (u, o) => (__asked.push(o), g(u, o)); return true; })()`);
	await app.eval(`(globalThis.__desktopGoto('/threads/2', { state: { draft: 'text' }, persistState: true, reset: false }), true)`);
	await until(async () => (await inView<unknown[]>(tab, '__asked')).length === 1, 'asked');
	expect(await inView(tab, '__asked[0]')).toMatchObject({ persistState: true, reset: false });
	await inView(tab, `(__restore(), true)`);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/1'`), 'back');
});

test("a kept route's tab just opened gets the state of the goto() that opened it", async () => {
	const before = (await items()).map((t) => t.id);
	await app.eval(`(globalThis.__desktopGoto('/live/with-state', { state: { selected: '42', when: new Date(86400000) } }), true)`);
	await until(async () => (await items()).some((t) => t.path === '/live/with-state'), 'its tab');
	const id = (await items()).find((t) => t.path === '/live/with-state')!.id;
	expect(before).not.toContain(id);
	await until(() => inView<boolean>(id, `globalThis.__desktopEntryState()?.selected === '42'`), 'its state');
	expect(await inView(id, `globalThis.__desktopEntryState().when instanceof Date`)).toBe(true);
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test('invalidating with the address elsewhere: the page and the address stay', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/1', 'at the first');
	await click('/threads/3');
	await until(() => app.eval<boolean>(`location.pathname === '/threads/3'`), 'the address');
	await app.eval(`window.__invalidateAll()`);
	await Bun.sleep(100);
	expect(await app.eval(`[location.pathname, window.__pageUrl()]`)).toEqual(['/threads/3', '/threads/3']);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/1', 'back');
});

test('back to where it is while it goes elsewhere: that one is called off', async () => {
	const id = await app.eval<string>(`window.__tabs.open('/numbers/new').id`);
	await drawn(id);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${id}'`), 'in focus');
	await click('/slow', '/numbers/new');
	await Bun.sleep(1200); // /slow takes 700 ms
	expect(await inView<string>(id, 'location.pathname')).toBe('/numbers/new');
	expect((await items()).find((t) => t.id === id)?.path).toBe('/numbers/new');
	await app.eval(`(window.__tabs.close('${id}'), true)`);
});

test('on another site, a kept route then another page: the latest one wins', async () => {
	const site = await app.eval<string>(`window.__tabs.open('http://127.0.0.1:9/').id`);
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${site}'`), 'in focus');
	const count = (await items()).length;
	await click('/live/overtaken', '/threads/4');
	await until(async () => (await items()).find((t) => t.id === site)?.path === '/threads/4', 'the last link');
	await Bun.sleep(300);
	expect((await items()).length).toBe(count);
	expect(await app.eval(`window.__tabs.activeId`)).toBe(site);
	await app.eval(`(window.__tabs.close('${site}'), true)`);
});

test('host.webview.reload() from a pane: that page, not the window and the others', async () => {
	const [first, second] = await panes();
	await inView(first!.active, `(globalThis.__draft = 'mine', true)`);
	await inView(second!.active, `(globalThis.__draft = 'mine', true)`);
	await app.eval(`(globalThis.__draft = 'mine', true)`);
	await inView(second!.active, `(host.webview.reload(), true)`);
	await until(() => inView<boolean>(second!.active, `globalThis.__draft === undefined && !!document.querySelector('[data-alive]')`), 'reloaded');
	expect(await inView(first!.active, `globalThis.__draft`)).toBe('mine');
	expect(await app.eval(`globalThis.__draft`)).toBe('mine');
});

test('a link while the last one is still being resolved: the latest one wins', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'in focus');
	const count = (await items()).length;
	await click('/live/resolving', '/threads/3');
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/3', 'the last link');
	await Bun.sleep(300);
	expect((await items()).length).toBe(count);
	expect(await app.eval(`window.__tabs.activeId`)).toBe(tab);
	await app.eval(`(globalThis.__desktopGoto('/threads/1'), true)`);
	await until(async () => (await inView<string>(tab, 'location.pathname')) === '/threads/1', 'back');
});

test('a host.popover.show() rect in a pane: in that pane, not in the window', async () => {
	if (process.platform !== 'darwin') return; // where the popover's frame is reported
	const pane = (await panes())[1]!;
	const tab = pane.active;
	await app.platform('popover', 'create', { id: 'in-pane', route: '/', style: 'popover', width: 120, height: 80, activate: false, behavior: 'manual' });
	await inView(tab, `host.popover.show('in-pane', { anchor: { x: 20, y: 20, width: 10, height: 10 } })`);
	await until(() => app.platform<boolean>('popover', 'isShown', { id: 'in-pane' }), 'shown');
	const { frame } = await app.platform<{ frame: Box }>('popover', 'get', { id: 'in-pane' });
	const { bounds: win } = await app.platform<{ bounds: Box }>('window', 'getBounds');
	const view = await bounds(tab);
	expect(Math.abs(frame.x + frame.width / 2 - (win.x + view.x + 25))).toBeLessThan(30);
	await app.platform('popover', 'destroy', { id: 'in-pane' });
});

test("a click on a pane's notification: back to that page, its tab on screen", async () => {
	if (process.platform !== 'darwin' || process.env.DESKTOP_TEST_DEV) return; // the test channel's op, needs a .app
	const pane = (await panes())[1]!;
	const tab = pane.active;
	const other = await app.eval<string>(`window.__tabs.open('/threads/4', { pane: '${pane.id}' }).id`);
	await until(async () => (await panes())[1]!.active === other, 'another tab on screen');
	await inView(tab, `(globalThis.__notified = [], host.notifications.on('click', (e) => (e.preventDefault(), globalThis.__notified.push(e.id))), true)`);
	await app.eval(`(globalThis.__notified = [], host.notifications.on('click', (e) => (e.preventDefault(), e.target && globalThis.__notified.push(e.id))), true)`);
	await app.platform('notifications', 'simulateResponse', { id: 'from-pane', fromView: viewId(tab) });
	await until(async () => (await inView<string[]>(tab, 'globalThis.__notified')).includes('from-pane'), 'the page that showed it');
	await until(async () => (await panes())[1]!.active === tab, 'its tab on screen');
	expect(await app.eval(`globalThis.__notified`)).not.toContain('from-pane');
	await app.eval(`(window.__tabs.close('${other}'), true)`);
});

test("a page's window: its own, not the one with the focus", async () => {
	const pane = (await panes())[0]!;
	const tab = pane.active;
	const { windowId } = await app.platform<{ windowId: number }>('window', 'create', { label: 'other', path: '/', width: 320, height: 240 });
	await app.platform('window', 'focus', { windowId });
	await until(() => app.platform<boolean>('window', 'isFocused', { windowId }), 'the other one focused', 3000).catch(() => {});
	const info = await inView<{ label: string }>(tab, `host.window.getInfo()`);
	expect(info.label).toBe('main');
	await app.platform('window', 'close', { windowId });
	await app.platform('window', 'focus');
});

test('another site with its own router: the tab reopens where it was', async () => {
	const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>Site</title><body>site</body>', { headers: { 'content-type': 'text/html' } }) });
	try {
		const pane = (await panes())[1]!;
		const url = `http://127.0.0.1:${server.port}/docs/one`;
		const made = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open(${JSON.stringify(url)}, { pane: '${pane.id}', reuse: false }).id }))()`);
		await until(() => inView<boolean>(made.id, `location.pathname === '/docs/one' && document.readyState === 'complete'`), 'loaded');
		await inView(made.id, `(history.pushState({}, '', '/docs/two'), true)`);
		const moved = `http://127.0.0.1:${server.port}/docs/two`;
		await until(async () => (await app.eval<string>(`window.__tabs.get('${made.id}').url`)) === moved, 'the tab knows');
		await app.eval(`(window.__tabs.close('${made.id}'), true)`);
		await until(async () => !(await items()).some((t) => t.id === made.id), 'closed');
		await until(async () => !(await app.platform<{ id: string }[]>('view', 'list')).some((v) => v.id === viewId(made.id)), 'gone');
		await app.eval(`(window.__tabs.reopen(), true)`);
		await until(() => inView<boolean>(made.id, `location.pathname === '/docs/two'`), 'reopened there');
		await app.eval(`(window.__tabs.close('${made.id}'), true)`);
	} finally {
		server.stop(true);
	}
});

test('two links quickly: the latest wins, back to where it is included', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	const at = (await items()).find((t) => t.id === tab)!.path!;
	await app.eval(`(() => {
		const side = document.querySelector('.sidebar');
		const link = (href) => { const a = document.createElement('a'); a.href = href; a.dataset.test = '1'; side.append(a); return a; };
		link('/slow').click();
		link('${at}').click();
		side.querySelectorAll('[data-test]').forEach((a) => a.remove());
		return true;
	})()`);
	await Bun.sleep(1500); // /slow takes 700 ms
	expect(await inView<string>(tab, 'location.pathname')).toBe(at);
	expect((await items()).find((t) => t.id === tab)?.path).toBe(at);
});

test('Back in the window while a link is on its way: Back wins', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	const at = (await items()).find((t) => t.id === tab)!.path!;
	await until(() => app.eval<boolean>(`location.pathname === '${at}'`), 'the address');
	await app.eval(`(globalThis.__desktopGoto('/slow'), true)`);
	await until(() => app.eval<boolean>(`location.pathname === '/slow'`), 'on its way');
	await app.eval(`(history.back(), true)`);
	await Bun.sleep(1500); // /slow takes 700 ms
	expect(await inView<string>(tab, 'location.pathname')).toBe(at);
	expect((await items()).find((t) => t.id === tab)?.path).toBe(at);
	expect(await app.eval(`location.pathname`)).toBe(at);
});

test('closed and reopened while a link is on its way: the new one stays where it is', async () => {
	const pane = (await panes())[1]!;
	const made = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/threads/31', { pane: '${pane.id}', reuse: false }).id }))()`);
	await drawn(made.id);
	await app.eval(`(() => {
		const a = document.createElement('a');
		a.href = '/slow';
		document.querySelector('.sidebar').append(a);
		a.click();
		a.remove();
		window.__tabs.close('${made.id}');
		return true;
	})()`);
	await until(async () => !(await app.platform<{ id: string }[]>('view', 'list')).some((v) => v.id === viewId(made.id)), 'its view gone');
	await app.eval(`(window.__tabs.reopen(), true)`);
	await drawn(made.id);
	await Bun.sleep(1500);
	expect((await items()).find((t) => t.id === made.id)?.path).toBe('/threads/31');
	await app.eval(`(window.__tabs.close('${made.id}'), true)`);
	await until(async () => !(await items()).some((t) => t.id === made.id), 'closed');
});

test('a press on a tab keeps the keyboard in the page: its view gets it when it is let go', async () => {
	const [left, right] = await panes();
	const tab = left!.tabs[0]!;
	await drawn(tab);
	// In a pane without the focus: pressing it mustn't send the keyboard there yet either.
	await app.eval(`(window.__tabs.focus('${right!.id}'), true)`);
	await Bun.sleep(200); // that focus has come and gone
	await app.eval(`(() => {
		const el = document.getElementById('app-tab-${tab}');
		const r = el.getBoundingClientRect();
		const init = { bubbles: true, pointerId: 9, button: 0, clientX: r.left + 10, clientY: r.top + 10 };
		el.dispatchEvent(new PointerEvent('pointerdown', init));
		el.dispatchEvent(new MouseEvent('mousedown', init));
		return true;
	})()`);
	expect(await app.eval(`window.__tabs.pageKeyboard`)).toBe(true);
	await app.eval(`(() => {
		const el = document.getElementById('app-tab-${tab}');
		const r = el.getBoundingClientRect();
		el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, button: 0, clientX: r.left + 10, clientY: r.top + 10 }));
		return true;
	})()`);
	expect(await app.eval(`window.__tabs.pageKeyboard`)).toBe(false);
	expect((await panes())[0]!.active).toBe(tab);
});

test("its page's own address (pushState from $app/navigation): the tab follows, and back", async () => {
	const pane = (await panes())[1]!;
	const tab = pane.active;
	const at = (await items()).find((t) => t.id === tab)!.path!;
	expect(at).toStartWith('/threads/');
	await inView(tab, `(document.querySelector('[data-shallow]').click(), true)`);
	await until(async () => (await items()).find((t) => t.id === tab)?.path === `${at}?filter=open`, 'the tab');
	await inView(tab, '(history.back(), true)');
	await until(async () => (await items()).find((t) => t.id === tab)?.path === at, 'back');
});

test("a view of the app's own beside the panes: its links are its own, whatever its id", async () => {
	const id = 'app-preview';
	await app.platform('view', 'create', { id, route: '/threads/1', bounds: { x: 10, y: 10, width: 200, height: 200 }, hidden: true });
	await until(() => app.platform<boolean>('view', 'executeJavaScript', { id, code: `!!document.querySelector('[data-alive]')` }), 'drawn');
	await Bun.sleep(200);
	await app.platform('view', 'executeJavaScript', { id, code: `(globalThis.__desktopGoto('/live'), true)` });
	await until(() => app.platform<boolean>('view', 'executeJavaScript', { id, code: `location.pathname === '/live'` }), 'it went');
	expect((await items()).some((t) => t.path === '/live')).toBe(false);
	await app.platform('view', 'destroy', { id });
});

test('a field of the window chosen while a view loads keeps the keyboard', async () => {
	const pane = (await panes())[0]!;
	await app.eval(`(() => { const i = document.createElement('input'); i.id = 'field'; document.querySelector('.sidebar').append(i); return true; })()`);
	const made = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/slow', { pane: '${pane.id}', reuse: false }).id }))()`);
	await app.eval(`(document.getElementById('field').focus(), true)`);
	expect(await app.eval(`window.__tabs.pageKeyboard`)).toBe(true);
	await until(() => inView<boolean>(made.id, `!!document.querySelector('[data-alive]')`), 'drawn', 12000);
	await Bun.sleep(300);
	expect(await app.eval(`document.activeElement?.id`)).toBe('field');
	await app.eval(`(document.getElementById('field').remove(), window.__tabs.close('${made.id}'), true)`);
	await until(async () => !(await items()).some((t) => t.id === made.id), 'closed');
}, 30_000);

test('the line between two panes reached with the keyboard keeps it too', async () => {
	const pane = (await panes())[0]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const made = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/slow', { pane: '${pane.id}', reuse: false }).id }))()`);
	// What Tab sends the page (a real key isn't sent to the machine's front app by a test). A press on
	// it is another matter: the keyboard goes back to the pane after.
	await app.eval(`(document.querySelector('[data-sd-splitter]').dispatchEvent(new FocusEvent('focusin', { bubbles: true })), true)`);
	expect(await app.eval(`window.__tabs.pageKeyboard`)).toBe(true);
	await until(() => inView<boolean>(made.id, `!!document.querySelector('[data-alive]')`), 'drawn', 12000);
	await Bun.sleep(300);
	expect(await app.eval(`window.__tabs.pageKeyboard`)).toBe(true); // nothing took it back
	await app.eval(`(window.__tabs.close('${made.id}'), true)`);
	await until(async () => !(await items()).some((t) => t.id === made.id), 'closed');
}, 30_000);

test('a tab bar too full: dragging to its end scrolls it, and the last place can be reached', async () => {
	const [left] = await panes();
	const made: string[] = [];
	for (let i = 0; i < 14; i++) made.push((await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/threads/${50 + i}', { pane: '${left!.id}', background: true, reuse: false }).id }))()`)).id);
	await until(async () => (await panes())[0]!.tabs.length >= 14, 'a full bar');
	const strip = `document.querySelector('[data-sd-pane="${left!.id}"] [data-sd-tabs]')`;
	expect(await app.eval<boolean>(`${strip}.scrollWidth > ${strip}.clientWidth`)).toBe(true);
	const r = await app.eval<Box>(`(() => { const r = ${strip}.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
	const tab = (await panes())[0]!.tabs[0]!;
	await dragTab(tab, { x: r.x + r.width - 6, y: r.y + r.height / 2 }, { release: false });
	try {
		await until(() => app.eval<boolean>(`${strip}.scrollLeft + ${strip}.clientWidth >= ${strip}.scrollWidth - 1`), 'scrolled to its end', 8000);
		await until(async () => (await app.eval<{ index: number }>(`window.__tabs.panes.drop`))?.index === (await panes())[0]!.tabs.length - 1, 'the last place', 2000);
	} catch (error) {
		console.log('[panes] the bar then', await app.eval(`({ scrollLeft: ${strip}.scrollLeft, clientWidth: ${strip}.clientWidth, scrollWidth: ${strip}.scrollWidth, drop: window.__tabs.panes.drop, visibility: document.visibilityState, focus: document.hasFocus(), dragging: document.documentElement.hasAttribute('data-sd-pane-dragging') })`));
		throw error;
	} finally {
		// Left going, it would take the next test's drags for its own.
		await app.eval(`(dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
	}
	// A full bar: + stays in sight, and so does the tab it shows, the last one too.
	const inBar = (selector: string) => app.eval<boolean>(`(() => { const s = ${strip}.parentElement.getBoundingClientRect(); const r = document.querySelector('[data-sd-pane="${left!.id}"] ${selector}').getBoundingClientRect(); return r.left >= s.left - 1 && r.right <= s.right + 1; })()`);
	expect(await inBar('[data-sd-tab-new]')).toBe(true);
	await app.eval(`(window.__tabs.activate(${JSON.stringify(made.at(-1))}), true)`);
	await until(() => inBar(`[id="app-tab-${made.at(-1)}"]`), 'the last one in sight');
	const first = (await panes())[0]!.tabs[0]!;
	await app.eval(`(window.__tabs.activate(${JSON.stringify(first)}), true)`);
	await until(() => inBar(`[id="app-tab-${first}"]`), 'the first one in sight');
	for (const id of made) await app.eval(`(window.__tabs.close('${id}'), true)`);
	await until(() => app.eval<boolean>(`${strip}.scrollWidth <= ${strip}.clientWidth`), 'closed');
	await onBody(left!.active);
}, 30_000);

test('a tab bar getting taller: the view under it follows', async () => {
	const [left] = await panes();
	const tab = left!.active;
	await onBody(tab);
	const was = await bounds(tab);
	await app.eval(`(document.querySelector('[data-sd-pane="${left!.id}"] [data-sd-tabbar]').style.height = '70px', true)`);
	await until(async () => (await bounds(tab)).y > was.y, 'moved down');
	await onBody(tab);
	await app.eval(`(document.querySelector('[data-sd-pane="${left!.id}"] [data-sd-tabbar]').style.height = '', true)`);
	await onBody(tab);
});

test('a pane entirely in the band along an edge: its view steps aside, and comes back', async () => {
	const [left, right] = await panes();
	const tab = left!.active;
	await app.eval(`(document.querySelector('[data-sd-splitter]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })), true)`);
	await until(async () => (await bounds(tab)).width === 180, 'at the minimum');
	const root = await app.eval<Box>(`(() => { const r = document.querySelector('[data-sd-panes]').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
	const mover = right!.tabs[0]!;
	await app.eval(`window.__tabs.open('/threads/8', { pane: '${right!.id}', reuse: false })`);
	await until(async () => (await panes())[1]!.tabs.length === 2, 'a second tab there');
	// Along the left edge: 25% of the panes, more than the left pane's 180 px.
	await dragTab(mover, { x: root.x + 8, y: root.y + 300 }, { release: false });
	await until(() => app.platform<{ hidden: boolean }>('view', 'getInfo', { id: viewId(tab) }).then((i) => i.hidden), 'out of the way');
	await app.eval(`(dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
	await until(() => app.platform<{ hidden: boolean }>('view', 'getInfo', { id: viewId(tab) }).then((i) => !i.hidden), 'back');
	await onBody(tab);
	await app.eval(`(document.querySelector('[data-sd-splitter]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true)`);
	await onBody(tab);
});

test('closed and reopened while it loads, three times: the new view stays', async () => {
	const pane = (await panes())[1]!;
	const made = await app.eval<{ id: string }>(`(() => { const t = window.__tabs.open('/slow', { pane: '${pane.id}', reuse: false }); return { id: t.id }; })()`);
	const list = () => app.platform<{ id: string }[]>('view', 'list');
	for (let i = 0; i < 3; i++) {
		await until(async () => (await list()).some((v) => v.id === viewId(made.id)), 'its view being made');
		expect(await inView<boolean>(made.id, `!!document.querySelector('[data-alive]')`).catch(() => false)).toBe(false); // not drawn yet
		await app.eval(`(window.__tabs.close('${made.id}'), true)`);
		await until(async () => !(await items()).some((t) => t.id === made.id), 'closed');
		await Bun.sleep(40); // its action gone, its page still loading
		await app.eval(`(window.__tabs.reopen(), true)`);
		await until(async () => (await items()).some((t) => t.id === made.id), 'reopened');
	}
	await until(() => inView<boolean>(made.id, `!!document.querySelector('[data-alive]')`), 'drawn', 12000);
	await Bun.sleep(1000); // whatever was still going away has gone
	expect((await list()).filter((v) => v.id === viewId(made.id)).length).toBe(1);
	expect(await inView<string>(made.id, 'location.pathname')).toBe('/slow');
	await onBody(made.id);
	await app.eval(`(window.__tabs.close('${made.id}'), true)`);
	await until(async () => !(await items()).some((t) => t.id === made.id), 'closed');
}, 30_000);

describe('a keepAlive route from inside a view', () => {
	const inRight = async () => (await panes())[1]!.active;
	const path = (tab: string) => inView<string>(tab, 'location.pathname');
	const goto = (tab: string, to: string) => inView(tab, `(globalThis.__desktopGoto(${JSON.stringify(to)}), true)`);
	const liveTabs = async () => (await items()).filter((t) => t.path?.split(/[?#]/)[0] === '/live');
	const closeLive = async () => {
		for (const t of await liveTabs()) await app.eval(`(window.__tabs.close('${t.id}'), true)`);
		await until(async () => !(await liveTabs()).length, 'its tabs closed');
	};
	const toThread = async (tab: string, n: number) => {
		await goto(tab, `/threads/${n}`);
		await until(async () => (await path(tab)) === `/threads/${n}`, `at thread ${n}`);
		await until(async () => (await items()).find((t) => t.id === tab)?.path === `/threads/${n}`, 'the tab knows');
	};

	test('goto(), not open yet: a tab for it, this one stays where it was', async () => {
		const tab = await inRight();
		await toThread(tab, 2);
		// What the page holds: a draft, and a counter its component keeps.
		await inView(tab, `(() => { const i = document.querySelector('input'); i.value = 'draft'; i.dataset.mine = '1'; return true; })()`);
		const before = await inView<number>(tab, `Number(document.querySelector('[data-alive]').textContent)`);
		await goto(tab, '/live');
		await until(async () => (await liveTabs()).length === 1, 'its tab made');
		const live = (await liveTabs())[0]!;
		expect(live.id).not.toBe(tab);
		expect(await path(tab)).toBe('/threads/2');
		expect((await items()).find((t) => t.id === tab)?.path).toBe('/threads/2');
		// The same component, never replaced.
		expect(await inView(tab, `(() => { const i = document.querySelector('input'); return [i.value, i.dataset.mine]; })()`)).toEqual(['draft', '1']);
		expect(await inView<number>(tab, `Number(document.querySelector('[data-alive]').textContent)`)).toBeGreaterThanOrEqual(before);
		await closeLive();
	});

	test('goto(), open elsewhere: its tab comes in front; Back in this view is not a trap', async () => {
		const [left] = await panes();
		const tab = await inRight();
		await toThread(tab, 2);
		await toThread(tab, 3);
		await app.eval(`window.__tabs.open('/live', { pane: '${left!.id}' })`);
		await until(async () => (await liveTabs()).length === 1, 'its tab');
		const live = (await liveTabs())[0]!;
		await drawn(live.id);
		await app.eval(`(window.__tabs.focus('${(await panes())[1]!.id}'), true)`);
		await until(() => app.eval<boolean>(`window.__tabs.activeId === '${tab}'`), 'this tab in focus');
		await goto(tab, '/live');
		await until(() => app.eval<boolean>(`window.__tabs.activeId === '${live.id}'`), 'its tab in front');
		expect(await path(tab)).toBe('/threads/3');
		expect((await liveTabs()).length).toBe(1);
		// Back goes where it came from, the first time.
		await Bun.sleep(100);
		await inView(tab, '(history.back(), true)');
		await until(async () => (await path(tab)) === '/threads/2', 'back one');
		expect((await liveTabs()).length).toBe(1);
		await closeLive();
	});

	test('Back onto its route, open elsewhere: this page stays, its tab comes in front', async () => {
		const [left] = await panes();
		// A real entry for /live in a view's history: a tab that started there, then went elsewhere.
		const started = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/live', { reuse: false }).id }))()`);
		await drawn(started.id);
		await toThread(started.id, 3);
		await inView(started.id, `(() => { const i = document.querySelector('input'); i.value = 'kept'; return true; })()`);
		await app.eval(`window.__tabs.open('/live', { pane: '${left!.id}', reuse: false })`);
		await until(async () => (await liveTabs()).length === 1, 'its tab');
		const live = (await liveTabs())[0]!;
		await drawn(live.id);
		await app.eval(`(window.__tabs.activate('${started.id}'), true)`);
		await until(() => app.eval<boolean>(`window.__tabs.activeId === '${started.id}'`), 'this tab in focus');
		await inView(started.id, '(history.back(), true)');
		await until(() => app.eval<boolean>(`window.__tabs.activeId === '${live.id}'`), 'its tab in front');
		await until(async () => (await path(started.id)) === '/threads/3', 'this page where it was');
		await Bun.sleep(200);
		expect(await path(started.id)).toBe('/threads/3');
		expect((await items()).find((t) => t.id === started.id)?.path).toBe('/threads/3');
		expect(await inView(started.id, `document.querySelector('input').value`)).toBe('kept');
		await closeLive();
		await app.eval(`(window.__tabs.close('${started.id}'), true)`);
		await until(async () => !(await items()).some((t) => t.id === started.id), 'closed');
	});

	test('a link: never leaves the page, whichever target', async () => {
		const tab = await inRight();
		await toThread(tab, 4);
		const click = (target: string) => inView(tab, `(() => { const a = document.createElement('a'); a.href = '/live'; ${target ? `a.target = '${target}';` : ''} document.body.append(a); a.click(); a.remove(); return true; })()`);
		await click('');
		await until(async () => (await liveTabs()).length === 1, 'its tab');
		await click('_self');
		await Bun.sleep(150);
		expect((await liveTabs()).length).toBe(1);
		expect(await path(tab)).toBe('/threads/4');
		await closeLive();
	});

	test('its own tab: within its route, and duplicates opened on purpose, nothing moves', async () => {
		const a = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/live?one', { reuse: false }).id }))()`);
		const b = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/live?two', { reuse: false }).id }))()`);
		await Promise.all([drawn(a.id), drawn(b.id)]);
		await inView(a.id, `(globalThis.__desktopGoto('/live?three'), true)`);
		await until(async () => (await items()).find((t) => t.id === a.id)?.path === '/live?three', 'moved within its route');
		expect(await inView<string>(a.id, 'location.pathname + location.search')).toBe('/live?three');
		expect((await items()).find((t) => t.id === b.id)?.path).toBe('/live?two');
		expect(await app.eval('window.__tabs.activeId')).toBe(b.id); // nothing else came in front
		await closeLive();
	});
});

test('a tab dropped on a side: a new pane, the same page still running', async () => {
	const [left, right] = await panes();
	const tab = left!.tabs[0]!;
	await inView(tab, `(window.__alive = 'still here', true)`);
	const seconds = () => inView<number>(tab, `Number(document.querySelector('[data-alive]').textContent)`);
	const before = await seconds();
	const box = await body(right!.id);
	await dragTab(tab, { x: box.x + box.width / 2, y: box.y + box.height - 60 });
	await until(async () => (await panes()).length === 3, 'three panes');
	expect(await app.eval(`(() => { const r = window.__tabs.panes.root; return [r.direction, r.children.map((c) => c.type + (c.direction ?? ''))]; })()`)).toEqual(['row', ['pane', 'splitcolumn']]);
	await onBody(tab);
	expect(await inView<string>(tab, `window.__alive`)).toBe('still here');
	// It counts on from there (the system slows a hidden page's timers: it was in the background).
	await until(async () => (await seconds()) > before, 'still counting');
});

test('a tab dropped on a bar joins it; the pane it leaves goes with its last tab', async () => {
	const all = await panes();
	const lone = all.find((p) => p.tabs.length === 1 && p.id !== all[0]!.id)!;
	const tab = lone.tabs[0]!;
	await inView(tab, `(window.__alive = 'moved', true)`);
	const bar = await app.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-sd-pane="${all[0]!.id}"] [data-sd-tabbar]').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`);
	await dragTab(tab, bar);
	await until(async () => (await panes()).length === 2, 'its pane gone');
	const first = (await panes())[0]!;
	expect(first.tabs[0]).toBe(tab);
	expect(first.active).toBe(tab);
	await onBody(tab);
	expect(await inView<string>(tab, `window.__alive`)).toBe('moved');
});

test('along the edge of the panes: a whole side of the window', async () => {
	const all = await panes();
	const first = all[0]!;
	const tab = first.tabs.at(-1)!;
	const root = await app.eval<Box>(`(() => { const r = document.querySelector('[data-sd-panes]').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
	await onBody(all[1]!.active);
	const was = await bounds(all[1]!.active);
	await dragTab(tab, { x: root.x + root.width / 2, y: root.y + root.height - 10 }, { release: false });
	await until(() => app.eval<boolean>(`document.querySelector('[data-sd-pane-drop-root]')?.getAttribute('data-sd-pane-drop') === 'bottom'`), 'the zone');
	await until(async () => (await bounds(all[1]!.active)).height < was.height, 'room made along the side');
	await app.eval(`(document.getElementById('app-tab-${tab}').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, button: 0, clientX: ${root.x + root.width / 2}, clientY: ${root.y + root.height - 10} })), true)`);
	await until(async () => (await app.eval<string>(`window.__tabs.panes.root.direction`)) === 'column', 'a column');
	expect(await app.eval(`window.__tabs.panes.root.children.at(-1).tabs`)).toEqual([tab]);
	// Back beside the first pane, for what follows.
	await app.eval(`(window.__tabs.panes.moveToPane('${tab}', '${first.id}'), true)`);
	await until(async () => (await panes()).length === all.length, 'back');
});

test('a tab that is not the active one is out of the window; its page runs on', async () => {
	const [first] = await panes();
	const hidden = first!.tabs.find((t) => t !== first!.active)!;
	await until(() => app.platform<{ hidden: boolean }>('view', 'getInfo', { id: viewId(hidden) }).then((i) => i.hidden), 'hidden');
	const a = await inView<number>(hidden, `Number(document.querySelector('[data-alive]').textContent)`).catch(() => -1);
	expect(a).toBeGreaterThanOrEqual(0);
});

test('a link in the window moves the tab in focus; its own router, and the address follows', async () => {
	const pane = (await panes())[1]!;
	await app.eval(`(window.__tabs.focus('${pane.id}'), true)`);
	const tab = pane.active;
	await inView(tab, `(window.__stay = 1, true)`);
	await app.eval(`(document.querySelector('.sidebar a[href="/threads/3"]').click(), true)`);
	await until(() => inView<boolean>(tab, `location.pathname === '/threads/3'`), 'the view went there');
	expect(await inView<number>(tab, `window.__stay`)).toBe(1); // no reload
	await until(async () => (await items()).find((t) => t.id === tab)?.path === '/threads/3', 'the tab knows');
	await until(() => app.eval<boolean>(`location.pathname === '/threads/3'`), "the window's address");
	await until(async () => (await items()).find((t) => t.id === tab)?.title === 'Thread 3', 'its title');
	// In the view: its router tells the tab, and a link for a new tab stays in the app.
	await inView(tab, `(document.querySelector('a[href="/threads/4"]').click(), true)`);
	await until(async () => (await items()).find((t) => t.id === tab)?.path === '/threads/4', 'moved within');
	const count = (await items()).length;
	await inView(tab, `(document.querySelector('a[target=_blank]').click(), true)`);
	await until(async () => (await items()).length === count + 1, 'a tab next to it');
	expect((await panes()).find((p) => p.id === pane.id)!.tabs.length).toBe(pane.tabs.length + 1);
});

test('the keyboard: next tab and next pane stay within what shows', async () => {
	const all = await panes();
	await app.eval(`(window.__tabs.focus('${all[0]!.id}'), true)`);
	const before = (await panes())[0]!.active;
	await app.eval(`(window.__tabs.cycle(1), true)`);
	const after = (await panes())[0]!;
	expect(after.active).not.toBe(before);
	expect(after.tabs).toContain(after.active);
	await app.eval(`(window.__tabs.focusPane(1), true)`);
	expect((await panes())[1]!.focused).toBe(true);
	expect(await app.eval(`window.__tabs.activeId`)).toBe((await panes())[1]!.active);
});

test('the layout comes back at the next launch', async () => {
	const before = await panes();
	const paths = await items();
	await Bun.sleep(1500); // saved, also on a busy machine
	await app.close();
	await start();
	await until(async () => (await panes()).length === before.length, 'the panes back');
	expect((await panes()).map((p) => p.tabs)).toEqual(before.map((p) => p.tabs));
	const back = await items();
	expect(back.map((t) => t.path).sort()).toEqual(paths.map((t) => t.path).sort());
	const active = (await panes())[0]!.active;
	await drawn(active);
	await onBody(active);
}, 60_000);

test('closing them all leaves one pane, on a new tab', async () => {
	await reset();
	await until(async () => (await panes()).length === 1 && (await items()).length === 1, 'one left');
	expect((await items())[0]!.path).toBe('/');
});
