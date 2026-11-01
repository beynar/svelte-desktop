// Tab drags with the real mouse (cliclick moves the system pointer — macOS, opt in):
//   DESKTOP_TEST_MOUSE=1 bun test tests/tabs-mouse.test.ts
// Reorder, drag out into a new window, drop onto that window's bar, and a page's own drag and
// drop (the calendar) with an isolated tab's hidden view in the window.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

const run = process.env.DESKTOP_TEST_MOUSE ? test : test.skip;
type Win = { windowId: number; label: string; bounds: { x: number; y: number; width: number; height: number } };
let app: AppHandle;
const sleep = (ms: number) => Bun.sleep(ms);
const names = (windowId = 0) =>
	app.platform<string[]>('webview', 'executeJavaScript', { windowId, code: `[...document.querySelectorAll('.app-tabs [role=tab]')].map((t) => t.textContent.replace('✕', '').trim())` });
// A tab's middle on the screen (hiddenInset: the page fills the window's frame).
const tabAt = async (i: number, windowId = 0) => {
	const { bounds } = await app.platform<Win>('window', 'getInfo', { windowId });
	const r = await app.platform<{ x: number; y: number }>('webview', 'executeJavaScript', {
		windowId,
		code: `(() => { const r = document.querySelectorAll('.app-tabs [role=tab]')[${i}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
	});
	return { x: Math.round(bounds.x + r.x), y: Math.round(bounds.y + r.y) };
};
// Press, move in steps (the system's drag needs a few moves to start), let go.
const drag = (from: { x: number; y: number }, ...path: Array<{ x: number; y: number }>) => {
	const to = path.at(-1)!;
	const moves = [{ x: from.x + 6, y: from.y + 2 }, ...path].map((p) => `dm:${p.x},${p.y}`);
	return Bun.$`cliclick -w 60 dd:${from.x},${from.y} ${moves} w:200 du:${to.x},${to.y}`.quiet();
};

beforeAll(async () => {
	if (!process.env.DESKTOP_TEST_MOUSE) return;
	app = await launch({ dev: true });
	await app.waitFor('.app-tabs [role=tab]', { timeout: 30_000 });
	await app.eval(`(window.__tabs.items = [], window.__tabs.open({ path: '/' }), window.__tabs.open({ path: '/board' }), window.__tabs.open({ path: '/calendar' }), true)`);
	await app.platform('window', 'setBounds', { x: 100, y: 100, width: 1200, height: 800 });
	await app.platform('window', 'focus');
	await sleep(1000);
}, 60_000);
afterAll(() => app?.close());

run('reorder: no text selected, the window stays', async () => {
	const a = await tabAt(0), c = await tabAt(2);
	await drag(a, { x: a.x + 40, y: a.y }, c, { x: c.x + 60, y: c.y });
	await sleep(500);
	expect(await names()).toEqual(['Board', 'Calendar', 'Overview']);
	expect(await app.eval('getSelection().toString()')).toBe('');
	expect((await app.platform<Win>('window', 'getInfo')).bounds).toMatchObject({ x: 100, y: 100 });
});

let torn: Win;
run('drag out: a new window right away, where the tab was let go', async () => {
	const b = await tabAt(1);
	await drag(b, { x: b.x + 20, y: b.y + 60 }, { x: b.x + 40, y: b.y + 200 }, { x: 900, y: 700 }, { x: 1500, y: 1000 }, { x: 1510, y: 1010 });
	const up = Date.now();
	let wins: Win[] = [];
	for (let i = 0; i < 100 && wins.length < 2; i++) (wins = await app.platform<Win[]>('window', 'list')), await sleep(10);
	expect(Date.now() - up).toBeLessThan(400); // no slide back before it opens
	torn = wins.find((w) => w.label !== 'main')!;
	expect(torn.bounds.x).toBe(1510 - 120);
	expect(await names()).toEqual(['Board', 'Overview']);
});

run("drop onto another window's bar: the tab moves there", async () => {
	for (let i = 0; i < 50 && !(await names(torn.windowId).catch(() => [])).length; i++) await sleep(50);
	await sleep(400); // shown (its entrance animation done)
	await app.platform('window', 'setBounds', { x: 1350, y: 150, width: 650, height: 500, windowId: torn.windowId });
	await app.platform('window', 'focus', { windowId: 0 });
	await sleep(800);
	const src = await tabAt(0), dst = await tabAt(0, torn.windowId);
	await drag(src, { x: src.x + 20, y: src.y + 60 }, { x: src.x + 60, y: src.y + 120 }, { x: dst.x, y: dst.y + 60 }, { x: dst.x + 100, y: dst.y }, { x: dst.x + 110, y: dst.y });
	await sleep(1000);
	expect(await names(torn.windowId)).toEqual(['Calendar', 'Board']);
	expect(await names()).toEqual(['Overview']);
	await app.platform('window', 'close', { windowId: torn.windowId });
});

run("the page's own drag and drop works with an isolated tab's view hidden in the window", async () => {
	await app.eval(`(window.__tabs.open({ id: 'docs', url: 'https://example.com' }), true)`);
	await sleep(1500); // its view, shown
	await app.eval(`(window.__tabs.open({ path: '/calendar' }), true)`);
	await app.waitFor('[data-event-calendar-part=item]', { timeout: 10_000 });
	await sleep(800);
	await app.platform('window', 'focus', { windowId: 0 });
	await sleep(300);
	await app.eval(`(window.__log = [], ['mousedown', 'dragstart', 'drop'].forEach((t) => addEventListener(t, () => window.__log.push(t), true)), true)`);
	const { bounds } = await app.platform<Win>('window', 'getInfo', { windowId: 0 });
	const ev = await app.eval<{ x: number; y: number }>(`(() => { const r = [...document.querySelectorAll('[data-event-calendar-part=item]')].map((e) => e.getBoundingClientRect()).find((r) => r.width > 20 && r.top > 150 && r.bottom < innerHeight - 120); return { x: r.left + r.width / 2, y: r.top + 8 }; })()`);
	const from = { x: Math.round(bounds.x + ev.x), y: Math.round(bounds.y + ev.y) };
	await drag(from, { x: from.x + 10, y: from.y + 40 }, { x: from.x + 10, y: from.y + 80 });
	await sleep(600);
	expect(await app.eval('window.__log')).toEqual(['mousedown', 'dragstart', 'drop']);
	await app.eval(`(window.__tabs.close('docs'), true)`);
});
