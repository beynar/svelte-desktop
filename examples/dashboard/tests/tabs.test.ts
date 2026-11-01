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
