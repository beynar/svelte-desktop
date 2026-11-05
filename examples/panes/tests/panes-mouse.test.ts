// With the real mouse (cliclick moves the system pointer — macOS, opt in):
//   DESKTOP_TEST_MOUSE=1 bun test tests/panes-mouse.test.ts
// What synthetic events can't tell: the pointer stays with the page it was pressed in while it
// crosses another pane's web view, a press in a view gives its pane the focus.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

const enabled = process.env.DESKTOP_TEST_MOUSE === '1';
const run = enabled ? test : test.skip;
let app: AppHandle;
type Box = { x: number; y: number; width: number; height: number };
const panes = () => app.eval<{ id: string; tabs: string[] }[]>(`window.__tabs.panes.panes.map((p) => ({ id: p.id, tabs: [...p.tabs] }))`);
const win = () => app.platform<{ bounds: Box }>('window', 'getInfo').then((i) => i.bounds);
const rect = (selector: string) => app.eval<Box>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
// The pointer is the user's: nothing is sent unless this very app, and its window, are in front.
const front = async () => {
	const pid = (await Bun.$`lsappinfo info -only pid $(lsappinfo front)`.quiet().text()).match(/\d+/)?.[0];
	const { processes } = await app.eval<{ processes: { type: string; pid: number }[] }>(`host.app.metrics()`);
	const mine = processes.find((p) => p.type === 'main')?.pid;
	if (String(mine) !== pid) throw new Error(`not sending the mouse: pid ${pid} is in front, this app is ${mine}`);
	if (!(await app.eval<boolean>(`host.window.isFocused()`))) throw new Error('not sending the mouse: its window is not the focused one');
};
const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
	await front();
	const steps = [0.1, 0.3, 0.6, 0.9, 1].map((k) => `dm:${Math.round(from.x + (to.x - from.x) * k)},${Math.round(from.y + (to.y - from.y) * k)}`);
	await Bun.$`cliclick -w 60 dd:${from.x},${from.y} ${steps} w:200 du:${to.x},${to.y}`.quiet();
};

beforeAll(async () => {
	if (!enabled) return;
	app = await launch();
	await app.waitFor(() => !!(globalThis as any).__tabs?.items?.length, { timeout: 30_000 });
	await app.eval(`(() => { const t = window.__tabs; for (const x of [...t.items]) t.close(x.id); t.open('/threads/1', { reuse: false }); t.open('/threads/2', { split: 'right', reuse: false }); return true; })()`);
	await app.platform('window', 'setBounds', { x: 120, y: 120, width: 1200, height: 760 });
	await app.platform('window', 'focus');
	await Bun.sleep(1500);
}, 60_000);
afterAll(() => app?.close());

run("a tab dragged over the other pane's view lands on its side", async () => {
	const w = await win();
	const [left, right] = await panes();
	const tabId = left!.tabs.at(-1)!;
	const tab = await rect(`[id="app-tab-${tabId}"]`);
	const body = await rect(`[data-sd-pane="${right!.id}"] > [data-sd-pane-body]`);
	await drag({ x: w.x + tab.x + tab.width / 2, y: w.y + tab.y + tab.height / 2 }, { x: w.x + body.x + body.width / 2, y: w.y + body.y + body.height - 30 });
	await Bun.sleep(500);
	const after = await panes();
	expect(after.some((p) => p.tabs.length === 1 && p.tabs[0] === tabId && p.id !== left!.id)).toBe(true);
	expect(await app.eval(`window.__tabs.panes.root.children.at(-1).direction`)).toBe('column');
});

run('a press in a view gives its pane the focus', async () => {
	const w = await win();
	const all = await panes();
	const first = all[0]!;
	await app.eval(`(window.__tabs.focus('${all.at(-1)!.id}'), true)`);
	const body = await rect(`[data-sd-pane="${first.id}"] > [data-sd-pane-body]`);
	await front();
	await Bun.$`cliclick -w 60 c:${Math.round(w.x + body.x + body.width / 2)},${Math.round(w.y + body.y + body.height / 2)}`.quiet();
	await Bun.sleep(300);
	expect(await app.eval(`window.__tabs.panes.focusedId`)).toBe(first.id);
});

run('the boundary moves with the mouse, over the views on both sides', async () => {
	const w = await win();
	const bar = await rect('[data-sd-splitter]');
	const left = await rect(`[data-sd-pane="${(await panes())[0]!.id}"]`);
	const x = w.x + bar.x + bar.width / 2;
	const y = w.y + bar.y + 200;
	await drag({ x, y }, { x: x - 150, y });
	await Bun.sleep(400);
	expect(Math.abs((await rect(`[data-sd-pane="${(await panes())[0]!.id}"]`)).width - (left.width - 150))).toBeLessThan(4);
});
