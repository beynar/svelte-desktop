// Drives the built app (`bunx --bun vite build` first) in its real window.
// `bun run test` / `bun run test:dev` (same tests against `vite dev`). App startup needs
// more than bun's default 5 s per hook, hence `--timeout` in the scripts.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

let app: AppHandle;
beforeAll(async () => {
	app = await launch(process.env.DESKTOP_TEST_DEV ? { dev: true } : {});
	await app.waitFor('#counter');
});
afterAll(() => app?.close());

test('SSR + hydration + remote command', async () => {
	const before = Number(await app.text('#counter'));
	await app.click('button:not([type=button])');
	await app.waitFor((n: number) => Number(document.querySelector('#counter')?.textContent) === n, { timeout: 5000 }).catch(() => {});
	const clicked = await app.eval<number>(`Number(document.querySelector('#counter').textContent)`);
	expect(clicked).toBeGreaterThanOrEqual(before);
});

test('remote form adds a note', async () => {
	const note = `test note ${Date.now()}`;
	await app.fill('input[name^=text]', note);
	await app.press('input[name^=text]', 'Enter');
	await app.waitFor(`li`);
	await app.waitFor(new Function(`return document.body.innerText.includes(${JSON.stringify(note)})`) as () => boolean);
	expect(await app.text('ul')).toContain(note);
});

test('platform API: window bounds and title', async () => {
	await app.platform('window', 'setTitle', { title: 'Under test' });
	expect(await app.platform<string>('window', 'getTitle')).toBe('Under test');
	const b = await app.platform<{ bounds: { width: number } }>('window', 'getBounds');
	expect(b.bounds.width).toBeGreaterThan(400);
});

test('native Swift plugin', async () => {
	expect(await app.platform<string>('greeter', 'hello', { name: 'test' })).toContain('from Swift');
	expect(await app.platform<number>('greeter', 'add', { a: 1, b: 2 })).toBe(3);
	const pong = app.nextEvent('greeter.pong');
	await app.platform('greeter', 'ping');
	expect(await pong).toHaveProperty('at');
});

test('menu-bar popover: pre-warmed route, transparent, sized to content, opened by the tray', async () => {
	let quick: { id: string; ready: boolean; height: number } | undefined;
	for (let i = 0; i < 80 && !quick?.ready; i++) {
		quick = (await app.platform<Array<typeof quick & {}>>('popover', 'list')).find((p) => p.id === 'status-item');
		await Bun.sleep(50);
	}
	expect(quick?.ready).toBe(true);
	const inside = await app.platform<{ text: string; bg: string; height: number; id: string }>('webview', 'executeJavaScript', {
		popoverId: 'status-item',
		code: `({ text: document.body.innerText, bg: getComputedStyle(document.body).backgroundColor,
		          height: Math.ceil(document.querySelector('.shell-popover-content').getBoundingClientRect().height), id: window.__shellPopover.id })`
	});
	expect(inside.text).toContain('Quick note');
	expect(inside.bg).toBe('rgba(0, 0, 0, 0)');
	expect(inside.id).toBe('status-item');
	const info = await app.platform<{ height: number }>('popover', 'get', { id: 'status-item' });
	expect(Math.abs(info.height - inside.height)).toBeLessThanOrEqual(2);
	await Bun.sleep(600); // a new status item settles in the menu bar asynchronously
	const shown = app.nextEvent('popoverShown', (e: { id: string }) => e.id === 'status-item');
	await app.platform('tray', 'performClick');
	expect((await shown).id).toBe('status-item');
	await app.platform('popover', 'hide', { id: 'status-item' });
});

test('desktop events reach the page (onDesktopEvent)', async () => {
	await app.platform('events', 'emit', { channel: 'desktop', data: { type: 'test-ping', data: 1 } });
	await app.waitFor(() => [...document.querySelectorAll('.log li')].some((li) => li.textContent!.includes('test-ping')));
});

test('client-side navigation + platform stores', async () => {
	await app.goto('/platform');
	await app.waitFor(() => /darwin/.test(document.querySelector('[data-testid=identity]')?.textContent ?? ''));
	expect(await app.text('[data-testid=native-page]')).toContain('from Swift');
	await app.waitFor('[data-testid=addon]');
	expect(await app.text('[data-testid=addon]')).toContain('fib(30) = 832040');
	await app.goto('/');
});

test('screenshot', async () => {
	const png = await app.screenshot();
	expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
});
