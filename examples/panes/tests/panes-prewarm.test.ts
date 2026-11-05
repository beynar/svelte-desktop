// `prewarm` with panes (vite dev: the env reaches the page): a spare view taken to a keepAlive route
// goes there, its own navigation isn't mistaken for leaving for that route's tab.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

let app: AppHandle;
beforeAll(async () => {
	app = await launch({ dev: true, env: { VITE_PANES_PREWARM: '1' }, timeout: 60_000 });
	await app.waitFor(() => !!(globalThis as any).__tabs?.items?.length, { timeout: 30_000 });
	await app.eval(`(() => { const t = window.__tabs; for (const x of [...t.items]) t.close(x.id); return true; })()`);
}, 90_000);
afterAll(() => app?.close());

const until = async (check: () => Promise<boolean>, what: string, ms = 15_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check().catch(() => false)) return;
		await Bun.sleep(50);
	}
	throw new Error(`timed out: ${what}`);
};

test('the spare view goes to the route of the tab it is taken for', async () => {
	// The spare: one view more than there are tabs, at the root, drawn.
	await until(async () => {
		const [views, tabs] = await Promise.all([app.platform<unknown[]>('view', 'list'), app.eval<number>(`window.__tabs.items.length`)]);
		return views.length > tabs;
	}, 'a spare view');
	await Bun.sleep(1500); // hydrated
	const before = await app.platform<{ id: string }[]>('view', 'list');
	const made = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/live/one').id }))()`);
	const id = `app-${made.id}`;
	expect(before.some((v) => v.id === id)).toBe(true); // it took the spare, no new process
	await until(() => app.platform<string>('view', 'executeJavaScript', { id, code: 'location.pathname' }).then((p) => p === '/live/one'), 'at its route');
	await until(() => app.platform<boolean>('view', 'executeJavaScript', { id, code: `!!document.querySelector('[data-alive]')` }), 'drawn');
	expect(await app.eval(`window.__tabs.get('${made.id}').path`)).toBe('/live/one');
	expect(await app.eval(`window.__tabs.items.filter((t) => t.path === '/live/one').length`)).toBe(1);
}, 60_000);

test('the spare view taken by a goto() with a state: the state reaches its page', async () => {
	await until(async () => {
		const [views, tabs] = await Promise.all([app.platform<unknown[]>('view', 'list'), app.eval<number>(`window.__tabs.items.length`)]);
		return views.length > tabs;
	}, 'a spare view');
	await Bun.sleep(1500);
	await app.eval(`(globalThis.__desktopGoto('/live/stated', { state: { selected: '42' } }), true)`);
	await until(() => app.eval<boolean>(`window.__tabs.items.some((t) => t.path === '/live/stated')`), 'its tab');
	const id = `app-${await app.eval<string>(`window.__tabs.items.find((t) => t.path === '/live/stated').id`)}`;
	await until(() => app.platform<boolean>('view', 'executeJavaScript', { id, code: `globalThis.__desktopEntryState?.()?.selected === '42'` }), 'its state');
}, 60_000);

test('a spare view once taken: the mark of its first navigation is gone', async () => {
	await until(async () => {
		const [views, tabs] = await Promise.all([app.platform<unknown[]>('view', 'list'), app.eval<number>(`window.__tabs.items.length`)]);
		return views.length > tabs;
	}, 'a spare view');
	await Bun.sleep(1500);
	const made = await app.eval<{ id: string }>(`(() => ({ id: window.__tabs.open('/live/two').id }))()`);
	const id = `app-${made.id}`;
	await until(() => app.platform<string>('view', 'executeJavaScript', { id, code: 'location.pathname' }).then((p) => p === '/live/two'), 'there');
	await Bun.sleep(300);
	expect(await app.platform('view', 'executeJavaScript', { id, code: `globalThis.__desktopRetarget === undefined` })).toBe(true);
}, 60_000);
