// desktop.config `command` (built app): host.command installs `dashboard` on the user's PATH, and
// `dashboard <file>` from a terminal opens the file in the running app. Uninstalled afterwards.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';
import { realpathSync } from 'node:fs';

let app: AppHandle;
beforeAll(async () => {
	app = await launch();
	await app.waitFor('[data-theme-toggle]', { timeout: 30_000 });
});
afterAll(async () => {
	await app?.eval(`fetch('/modules/command', { method: 'DELETE' }).then((r) => r.json())`).catch(() => {});
	await app?.close();
}, 15_000);

test('install, open a file from the terminal, uninstall', async () => {
	const call = (method: string) => app.eval<any>(`fetch('/modules/command', { method: '${method}' }).then((r) => r.json())`);
	const before = await call('GET');
	expect(before).toMatchObject({ name: 'dashboard', available: true });
	const installed = await call('POST');
	expect(installed.error).toBeUndefined();
	expect(installed.path).toMatch(/\/dashboard$/);
	expect((await call('GET')).path).toBe(installed.path);
	// From a terminal: the file reaches the running app (onOpenFiles).
	await Bun.write(`/tmp/sd-research/command test.md`, '# hello');
	const file = realpathSync(`/tmp/sd-research/command test.md`); // macOS hands over the real path (/private/tmp)
	await app.eval(`(window.__opened = [], host.webview.onOpenFiles((e) => window.__opened.push(...e.paths)), true)`);
	const r = Bun.spawnSync([installed.path, file], { stderr: 'pipe' });
	expect(r.exitCode).toBe(0);
	await app.waitFor((f: string) => (window as any).__opened.includes(f), { timeout: 10_000, arg: file } as any).catch(() => {});
	expect(await app.eval<string[]>(`window.__opened`)).toContain(file);
	const after = await call('DELETE');
	expect(after.path).toBeNull();
}, 30_000);
