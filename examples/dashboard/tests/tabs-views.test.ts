// The views of kept-alive tabs (bun test tests/tabs-views.test.ts): one kept ready (`prewarm`), at
// most one running (`maxViews={1}`: the others suspended), and a launch opening on the saved tab.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

let app: AppHandle;
type View = { id: string; url: string | null };
const views = () => app.platform<View[]>('view', 'list');
const hidden = (id: string) => app.platform<{ hidden: boolean }>('view', 'getInfo', { id }).then((i) => i.hidden);
const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, tries = 60): Promise<T> => {
	let v = await get();
	for (let i = 0; i < tries && !ok(v); i++) (await Bun.sleep(100)), (v = await get());
	return v;
};
const start = async () => {
	app = await launch({ dev: true, env: { VITE_TABS_PREWARM: '1', VITE_TABS_MAX_VIEWS: '1' } });
	await app.waitFor('.app-tabs [role=tab]', { timeout: 30_000 });
	await app.platform('window', 'focus');
};
// Opened → its view in front (the tab shown), timed in the page; -1: not within 5 s.
const timedOpen = (code: string) =>
	app.eval<number>(`new Promise((resolve) => { const t = performance.now(); ${code}; const tabs = window.__tabs; const check = () => tabs.shown === tabs.activeId ? resolve(performance.now() - t) : performance.now() - t > 5000 ? resolve(-1) : setTimeout(check, 2); check(); })`);

beforeAll(async () => {
	await start();
	const dir = await app.platform<string>('app', 'getPath', { name: 'userData' });
	await Bun.file(`${dir}/tabs-app.json`).delete().catch(() => {});
	await app.eval(`(window.__reloading = true, setTimeout(() => location.assign('/'), 10), true)`);
	await app.waitFor(() => !(window as any).__reloading && !!document.querySelector('.app-tabs [role=tab]'), { timeout: 20_000 });
}, 60_000);
afterAll(() => app?.close(), 20_000);

test('prewarm: a view kept ready opens the next kept-alive tab at once — at its route, or taken to another', async () => {
	// Ready, out of sight, at the kept-alive route not open (/activity).
	const [spare] = await until(views, (v) => v.length === 1);
	expect(spare?.url).toEndWith('/activity');
	await until(() => hidden(spare!.id), (h) => h);
	await Bun.sleep(400);
	expect(await timedOpen(`window.__tabs.open('/activity')`)).toBeWithin(0, 80); // no process, no app start
	const first = await app.eval<string>('window.__tabs.active.id');
	expect(`app-${first}`).toBe(spare!.id);
	// The next one, at the app's root (/activity is open): another /activity goes there by the router.
	const next = (await until(views, (v) => v.length === 2)).find((v) => v.id !== spare!.id)!;
	expect(new URL(next.url!).pathname).toBe('/');
	await until(() => hidden(next.id), (h) => h);
	await Bun.sleep(400);
	expect(await timedOpen(`window.__tabs.open('/activity', { reuse: false })`)).toBeWithin(0, 250);
	const second = await app.eval<string>('window.__tabs.active.id');
	expect(`app-${second}`).toBe(next.id);
	expect(await app.platform('view', 'executeJavaScript', { id: next.id, code: `location.pathname + ' ' + !!document.querySelector('[data-activity-seconds]')` })).toBe('/activity true');
	expect(await app.eval('location.pathname')).toBe('/activity');
}, 30_000);

test('maxViews: beyond the limit the least recently shown view is suspended, and loads again when shown', async () => {
	const [first, second] = await app.eval<string[]>(`window.__tabs.items.filter((t) => t.path === '/activity').map((t) => t.id)`);
	// The second is shown: the first is suspended (its view gone, its tab marked).
	await until(views, (v) => !v.some((x) => x.id === `app-${first}`));
	expect((await views()).map((v) => v.id)).not.toContain(`app-${first}`);
	expect(await app.eval(`document.querySelector('#app-tab-${first}')?.hasAttribute('data-suspended')`)).toBe(true);
	// Shown again: a fresh view; now the second is suspended.
	await app.eval(`(window.__tabs.activate(${JSON.stringify(first)}), true)`);
	await until(() => hidden(`app-${first}`).catch(() => true), (h) => !h);
	expect(await app.eval(`document.querySelector('#app-tab-${first}')?.hasAttribute('data-suspended')`)).toBe(false);
	await until(views, (v) => !v.some((x) => x.id === `app-${second}`));
	expect(await app.eval(`document.querySelector('#app-tab-${second}')?.hasAttribute('data-suspended')`)).toBe(true);
}, 30_000);

test('a launch opens on the saved tab: no jump from the start page', async () => {
	await app.eval(`(() => { const t = window.__tabs; t.items.filter((x) => t.isIsolated(x)).forEach((x) => t.close(x.id)); t.open('/calendar'); return true; })()`);
	await app.waitFor(() => location.pathname === '/calendar');
	await Bun.sleep(800); // saved
	await app.close();
	await start();
	expect(await app.eval(`new URL(performance.getEntriesByType('navigation')[0].name).pathname`)).toBe('/calendar');
	expect(await app.eval('location.pathname')).toBe('/calendar');
}, 60_000);
