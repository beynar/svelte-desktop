// desktop.crashInfo() across launches of the built app: graceful quit → clean start;
// a killed process → the next start reports an unclean exit. (Built app only.)
import { expect, test } from 'bun:test';
import { launch } from '@svelte-desktop/shell/test';

const info = (app: Awaited<ReturnType<typeof launch>>) => app.eval<{ uncleanExit: boolean; previousLaunch: number | null; reports: unknown[] }>(`fetch('/api/crash').then((r) => r.json())`);

test.skipIf(!!process.env.DESKTOP_TEST_DEV)('unclean exit detection', async () => {
	let app = await launch();
	await app.close(); // graceful quit
	app = await launch();
	expect((await info(app)).uncleanExit).toBe(false);
	const { pid } = await app.platform<{ pid: number }>('diagnostics', 'info');
	process.kill(pid, 'SIGKILL');
	await Bun.sleep(500);
	app = await launch();
	const after = await info(app);
	expect(after.uncleanExit).toBe(true);
	expect(after.previousLaunch).toBeGreaterThan(0);
	await app.close();
}, 120_000);

test.skipIf(!!process.env.DESKTOP_TEST_DEV)('job history survives a restart', async () => {
	let app = await launch();
	const api = <T>(path: string, init?: RequestInit) => app.eval<T>(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then((r) => r.json())`);
	const job = await api<{ id: string }>('/api/jobs', { method: 'POST', body: JSON.stringify({ name: 'count', args: { to: 2, delay: 10 } }) });
	await api(`/api/jobs?id=${job.id}&wait=1`);
	await app.close();
	app = await launch();
	const list = await api<Array<{ id: string; state: string; restored?: boolean }>>('/api/jobs');
	expect(list.find((j) => j.id === job.id)).toMatchObject({ state: 'done', restored: true });
	await app.close();
}, 120_000);
