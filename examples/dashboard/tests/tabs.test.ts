// Tabs in the dashboard (bun test tests/tabs.test.ts): the window's tabs in the title bar and tabs
// inside pages, driven in the real window — screenshots in /tmp/dashboard-tabs-*.png.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

let app: AppHandle;
const titles = (bar: string) => app.eval<string[]>(`[...document.querySelectorAll('${bar} [role=tab]')].map((t) => t.textContent.replace('✕', '').trim())`);
const active = (bar: string) => app.eval<string>(`document.querySelector('${bar} [role=tab][data-active]')?.textContent.replace('✕', '').trim()`);
const shot = (name: string) => Bun.sleep(400).then(() => app.screenshot(`/tmp/dashboard-tabs-${name}.png`));

beforeAll(async () => {
	app = await launch({ dev: true });
	await app.waitFor('main', { timeout: 30_000 });
	// A clean slate: forget the tabs a previous run left.
	const dir = await app.platform<string>('app', 'getPath', { name: 'userData' });
	for (const f of ['tabs-app.json', 'tabs-boards.json']) await Bun.file(`${dir}/${f}`).delete().catch(() => {});
	await app.eval(`(window.__reloading = true, setTimeout(() => location.assign('/'), 10), true)`);
	await app.waitFor(() => !(window as any).__reloading && !!document.querySelector('.app-tabs [role=tab]'), { timeout: 20_000 });
}, 60_000);
afterAll(() => app?.close());

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
	expect(await titles('.app-tabs')).toEqual(['Overview', 'Board', 'Calendar']);
	expect(await active('.app-tabs')).toBe('Board'); // opened in the background
	expect(await app.eval('location.pathname')).toBe('/board');
	await shot('2-three-tabs');

	await app.eval(`document.querySelectorAll('.app-tabs [role=tab]')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
	await app.waitFor(() => location.pathname === '/');
	await Bun.sleep(200);
	expect(await app.platform<string>('window', 'getTitle')).toBe('Overview');
});

test('tabs inside a page: one board per tab, kept alive; a new board; fixed segmented tabs on the overview', async () => {
	await app.eval(`document.querySelector('.segmented [role=tab]:nth-child(2)').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
	await app.waitFor(() => document.querySelector('.segmented [role=tab][data-active]')?.textContent?.trim() === 'In progress');
	expect(await app.eval(`document.querySelectorAll('.segmented [data-sd-tab-new], .segmented button').length`)).toBe(0); // fixed: no + nor ×
	await shot('3-overview-segmented');

	await app.eval(`document.querySelectorAll('.app-tabs [role=tab]')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
	await app.waitFor(() => location.pathname === '/board' && !!document.querySelector('.board-tabs [role=tab]'));
	expect(await titles('.board-tabs')).toEqual(['Current sprint', 'Product backlog']);
	await app.eval(`document.querySelector('.board-tabs [data-sd-tab-new]').click()`);
	await app.waitFor(() => document.querySelectorAll('.board-tabs [role=tab]').length === 3);
	expect(await active('.board-tabs')).toBe('Board 3');
	expect(await app.eval(`document.querySelectorAll('[data-sd-tabpanel]').length`)).toBe(3); // all mounted
	expect(await app.eval(`document.querySelectorAll('[data-sd-tabpanel]:not([hidden])').length`)).toBe(1);
	await shot('4-board-tabs');
});

test('restored after a reload: the window tabs and the boards', async () => {
	await Bun.sleep(600); // the debounced save
	await app.eval(`(window.__reloading = true, setTimeout(() => location.reload(), 10), true)`);
	await app.waitFor(() => !(window as any).__reloading && document.querySelectorAll('.app-tabs [role=tab]').length === 3, { timeout: 20_000 });
	expect(await titles('.app-tabs')).toEqual(['Overview', 'Board', 'Calendar']);
	await app.waitFor(() => document.querySelectorAll('.board-tabs [role=tab]').length === 3, { timeout: 10_000 });
	expect(await titles('.board-tabs')).toEqual(['Current sprint', 'Product backlog', 'Board 3']);
	await shot('5-restored');
});

const pointer = (type: string, el: string, x: number, y: number, extra = '') =>
	app.eval(`(() => { const el = ${el}; el.dispatchEvent(new PointerEvent('${type}', { bubbles: true, pointerId: 7, button: 0, buttons: 1, clientX: ${x}, clientY: ${y}${extra} })); return true; })()`);

test('drag to reorder: pointer events, the window does not move', async () => {
	const order = await titles('.app-tabs');
	const box = await app.eval<{ x: number; y: number; right: number }>(`(() => { const t = document.querySelector('.app-tabs [role=tab]'); const b = t.getBoundingClientRect(); const bar = document.querySelector('.app-tabs').getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2, right: bar.right - 60 }; })()`);
	await pointer('pointerdown', `document.querySelector('.app-tabs [role=tab]')`, box.x, box.y);
	for (const x of [box.x + 40, box.x + 200, box.right]) await pointer('pointermove', `document.querySelector('.app-tabs')`, x, box.y);
	await pointer('pointerup', `document.querySelector('.app-tabs')`, box.right, box.y);
	expect(await titles('.app-tabs')).toEqual([...order.slice(1), order[0]!]);
});

test('an isolated tab: another site in its own web view, the page hidden while it shows', async () => {
	await app.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Docs').click()`);
	await app.waitFor(() => !!document.querySelector('[data-sd-tabview]:not([hidden])'), { timeout: 10_000 });
	let views: Array<{ id: string; url: string | null }> = [];
	for (let i = 0; i < 50 && !views.some((v) => v.id.startsWith('app-')); i++) (views = await app.platform('view', 'list')), await Bun.sleep(100);
	expect(views.some((v) => v.id.startsWith('app-'))).toBe(true);
	expect(await app.eval(`document.querySelector('[data-sd-tabcontent]').hidden`)).toBe(true);
	await shot('6-isolated');
	await app.eval(`document.querySelectorAll('.app-tabs [role=tab]')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
	await app.waitFor(() => !document.querySelector('[data-sd-tabcontent]')!.hasAttribute('hidden'));
	expect(await app.eval(`document.querySelector('[data-sd-tabview]').hidden`)).toBe(true); // kept, hidden
});

test('drag a tab out: it opens in its own window; a tab dropped from another window joins this bar', async () => {
	const before = await titles('.app-tabs');
	const box = await app.eval<{ x: number; y: number }>(`(() => { const b = document.querySelectorAll('.app-tabs [role=tab]')[1].getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })()`);
	const moved = before[1]!;
	await pointer('pointerdown', `document.querySelectorAll('.app-tabs [role=tab]')[1]`, box.x, box.y);
	await pointer('pointermove', `document.querySelector('.app-tabs')`, box.x + 10, box.y + 30);
	await pointer('pointermove', `document.querySelector('.app-tabs')`, box.x + 40, box.y + 300);
	await pointer('pointerup', `document.querySelector('.app-tabs')`, box.x + 40, box.y + 300, ', screenX: 300, screenY: 300');
	await app.waitFor(() => document.querySelectorAll('.app-tabs [role=tab]').length === 3, { timeout: 10_000 });
	expect(await titles('.app-tabs')).not.toContain(moved);
	let wins: Array<{ windowId: number; label: string }> = [];
	for (let i = 0; i < 50 && wins.length < 2; i++) (wins = await app.platform('window', 'list')), await Bun.sleep(100);
	const torn = wins.find((w) => w.label !== 'main');
	expect(torn?.label).toStartWith('app-');
	await shot('7-torn-off');
	// The reverse: a tab dropped on this window's bar from that window.
	await app.platform('events', 'emit', { channel: 'tabs:adopt', data: { group: 'app', target: 'main', tab: { id: 'x', title: 'Calendar', path: '/calendar', isolated: false, pinned: false, closable: true } } });
	await app.waitFor(() => document.querySelectorAll('.app-tabs [role=tab]').length === 4);
	await app.platform('window', 'close', { windowId: torn!.windowId });
});
