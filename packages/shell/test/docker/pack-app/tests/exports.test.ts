// Every entry point of the installed package loads where it's meant to, in the built app and under
// `vite dev`. Copied in a new project by test/docker/pack.sh; add a new export to one of the lists.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

const manifest = await Bun.file('node_modules/@kitop/shell/package.json').json();

// In src/routes/exports/+page.svelte.
const inPage = ['./client', './native', './tabs', './tabs/WindowTabs.svelte', './platform', './stores', './platform/MenuBar.svelte', './platform/StatusItem.svelte', './platform/Popover.svelte', './platform/PopoverContent.svelte', './platform/window-state', './platform/store', './ai', './ai-sdk'];
const onBun = ['.', './server', './websocket', './worker', './worker-env', './adapter', './updater', './push', './push-server', './push-protocol', './vite', './config', './test', './tailwind', './package.json'];
const notImported = ['./globals', './push/service-worker.js']; // types only; a service worker's script

let app: AppHandle;
beforeAll(async () => (app = await launch(process.env.DESKTOP_TEST_DEV ? { dev: true } : {})));
afterAll(() => app?.close());

test('no entry point is left out of this test', () => {
	expect([...inPage, ...onBun, ...notImported].sort()).toEqual(Object.keys(manifest.exports).sort());
});

test.each(onBun)('Bun loads %s', async (entry) => {
	expect(await import(`@kitop/shell${entry.slice(1)}`)).toBeDefined();
});

test('the service worker script resolves', () => {
	expect(Bun.resolveSync('@kitop/shell/push/service-worker.js', process.cwd())).toContain('service-worker.js');
});

test('a page renders and hydrates with every entry a page can use', async () => {
	// A real load, not a client navigation: the server renders it too.
	await app.eval(() => void (location.href = '/exports'));
	await app.waitFor(() => document.querySelector('#entries')?.getAttribute('data-hydrated') === 'true', { timeout: 60000 });
	expect(await app.text('#entries')).toBe(String(inPage.length));
});

test("the tab bar's drag library loads in the page", async () => {
	await app.waitFor('#drop[data-drop-target-for-element]', { timeout: 30000 });
});
