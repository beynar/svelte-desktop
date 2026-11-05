// What happens when things die, on a real packaged app (examples/notes with crash-probe.ts, from
// e2e.sh): the server, thrown out of or exiting on its own, and the web process, killed for real.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, type AppHandle } from '@kitop/shell/test';
import { appDirs } from '../../src/os.ts';

const dirs = appDirs('dev.kitop.notes');
const logFile = join(dirs.logs, 'app.log');
const storeFile = join(dirs.data, 'kitop-store.json');
let dir = '';

function executable() {
	const app = resolve('.desktop/dist/Svelte Notes');
	const entry = readdirSync(app).find((f) => f.endsWith('.desktop'))!;
	return join(app, /^Exec=(\S+)/m.exec(readFileSync(join(app, entry), 'utf8'))![1]!);
}

const running = () => {
	const out = Bun.spawnSync(['pgrep', '-f', executable()]).stdout.toString().trim();
	return out ? out.split('\n').map(Number) : [];
};
const killAll = () => Bun.spawnSync(['pkill', '-9', '-f', executable()]);
const starts = () => (existsSync(`${dir}/starts`) ? readFileSync(`${dir}/starts`, 'utf8').trim().split('\n').length : 0);
// The main window's: each view has its own count, and killing the web processes kills them all.
const webEvents = () => (existsSync(`${dir}/web`) ? readFileSync(`${dir}/web`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.window === 1) : []);
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out: ${what}`);
}

const env = (how?: string, extra: Record<string, string> = {}) => ({ ...process.env, CRASH_DIR: dir, ...(how ? { CRASH_HOW: how } : {}), ...extra }) as Record<string, string>;

/** `launch` follows an app that restarts itself, but a call made as it goes never comes back. */
const answers = (app: AppHandle, code: string) => Promise.race([app.eval(code).then(() => true).catch(() => false), Bun.sleep(1000).then(() => false)]);

const crashInfo = (app: AppHandle) => app.eval<{ uncleanExit: boolean; lastError: { message: string; time: number } | null }>(`fetch('/api/crash').then((r) => r.json())`);

/** The message box of an app that has stopped restarting. */
const dialogs = () => Bun.spawnSync(['xdotool', 'search', '--name', 'stopped working']).stdout.toString().trim().split('\n').filter(Boolean);

beforeEach(() => {
	dir = mkdtempSync('/tmp/crash-');
	mkdirSync(dirs.logs, { recursive: true });
	for (const file of [logFile, join(dirs.data, '.last-error'), join(dirs.data, '.crash-restarts'), storeFile]) rmSync(file, { force: true });
});

afterEach(async () => {
	killAll();
	await until('the app to be gone', () => running().length === 0);
});

test('a thrown error: the app restarts on its own, working, on the same origin, and says why', async () => {
	const app = await launch({ env: env('throw', { CRASH_ONCE: '1', CRASH_ON_GO: '1' }) });
	const { pid: before } = await app.platform<{ pid: number }>('diagnostics', 'info');
	const origin = app.origin;

	writeFileSync(`${dir}/go`, '');
	await until('a second start', () => starts() === 2);
	await until('the new process to answer', () => answers(app, 'location.origin'));
	await app.waitFor('#counter');

	const { pid: after } = await app.platform<{ pid: number }>('diagnostics', 'info');
	expect(after).not.toBe(before);
	expect(running()).not.toContain(before);
	// A new secret and cookie got it through the gate, on the port that keeps its storage.
	expect(await app.eval('location.origin')).toBe(origin);
	expect(await app.eval(`fetch('/').then((r) => r.status)`)).toBe(200);
	// The event sink: native events and platform results reach the new server.
	expect(await app.eval(`fetch('/api/crash').then((r) => r.status)`)).toBe(200);

	const info = await crashInfo(app);
	expect(info.uncleanExit).toBe(true);
	expect(info.lastError?.message).toContain('crash probe: thrown');
	expect(log()).toContain('crash probe: thrown');
	await app.close();
}, 120_000);

test('an unhandled rejection: logged, and the server and its page carry on', async () => {
	const app = await launch({ env: env('reject') });
	const { pid } = await app.platform<{ pid: number }>('diagnostics', 'info');
	await app.eval('window.__same_page = 1');
	await Bun.sleep(2000);

	expect((await app.platform<{ pid: number }>('diagnostics', 'info')).pid).toBe(pid);
	expect(await app.eval('window.__same_page')).toBe(1);
	expect(await app.eval(`fetch('/').then((r) => r.status)`)).toBe(200);
	expect(starts()).toBe(1);
	expect(app.stdout).toContain('crash probe: rejected');
	await app.close();
}, 60_000);

// Started directly: no terminal and no test channel, like an app started from a launcher.
for (const how of ['throw', 'import']) {
	test(`a server that keeps dying (${how}): a few restarts, a message, and the crash loop is over`, async () => {
		// Its very first launch: nothing of the app's on disk yet.
		rmSync(dirs.data, { recursive: true, force: true });
		const first = Bun.spawn([executable()], { env: env(how), stdout: 'ignore', stderr: 'ignore' });
		await until('the message', () => dialogs().length > 0, 60_000);

		expect(starts()).toBe(4); // the launch and three restarts
		expect(log()).toContain(how === 'throw' ? 'crash probe: thrown' : 'crash probe: at import');
		await first.exited;

		expect(running().length).toBe(1);
		Bun.spawnSync(['xdotool', 'windowactivate', '--sync', dialogs()[0]!, 'key', 'Return']);
		await until('the app to quit', () => running().length === 0);

		// It stays down.
		await Bun.sleep(1500);
		expect(running().length).toBe(0);
		expect(starts()).toBe(4);

		// The next launch, by the user, is told about it, and has its restarts back.
		const app = await launch({ env: { ...env(), CRASH_DIR: dir } });
		const info = await crashInfo(app);
		expect(info.uncleanExit).toBe(true);
		expect(info.lastError?.message).toContain('crash probe');
		await app.close();
	}, 120_000);
}

test('process.exit(0) in server code quits, cleanly and for good', async () => {
	const proc = Bun.spawn([executable()], { env: env('exit0'), stdout: 'ignore', stderr: 'ignore' });
	expect(await proc.exited).toBe(0);
	await Bun.sleep(1500);
	expect(running().length).toBe(0);
	expect(starts()).toBe(1);
	const app = await launch({ env: env() });
	expect((await crashInfo(app)).uncleanExit).toBe(false);
	await app.close();
}, 60_000);

test('process.exit(3) in server code counts as a crash', async () => {
	const app = await launch({ env: env('exit3', { CRASH_ONCE: '1', CRASH_ON_GO: '1' }) });
	writeFileSync(`${dir}/go`, '');
	await until('a second start', () => starts() === 2);
	await until('the new process to answer', () => answers(app, 'location.origin'));
	expect((await crashInfo(app)).lastError?.message).toContain('code 3');
	await app.close();
}, 60_000);

test('what server code set just before quitting is on disk', async () => {
	const stamp = String(Date.now());
	const proc = Bun.spawn([executable()], { env: env('store-then-quit', { CRASH_STAMP: stamp }), stdout: 'ignore', stderr: 'ignore' });
	const started = Date.now();
	expect(await proc.exited).toBe(0);
	// Well under the UI thread's 3 s: the write didn't wait on a run loop that had stopped.
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(JSON.parse(readFileSync(storeFile, 'utf8'))['set-just-before-quit']).toBe(stamp);
}, 60_000);

test('a web process that keeps dying: reloaded, later each time, then a page that says so, with a way back', async () => {
	const app = await launch({ env: env() });
	await app.waitFor('#counter');
	const killWebProcess = async (n: number) => {
		await until('a web process to kill', () => Bun.spawnSync(['pkill', '-9', '-f', 'WebKitWebProcess']).exitCode === 0);
		await until(`crash ${n} to be reported`, () => webEvents().length >= n);
	};

	for (let n = 1; n <= 3; n++) {
		await app.eval('window.__before_crash = 1');
		const crashed = Date.now();
		await killWebProcess(n);
		expect(webEvents()[n - 1].gaveUp).toBe(false);
		await app.waitFor('#counter', { timeout: 20_000 });
		expect(await app.eval('window.__before_crash ?? null')).toBeNull();
		if (n === 3) expect(Date.now() - crashed).toBeGreaterThan(3500); // the longest delay
	}

	await killWebProcess(4);
	expect(webEvents()[3].gaveUp).toBe(true);
	await until('the page that says so', async () => (await app.eval<string>('location.pathname').catch(() => '')) === '/__desktop/page-crashed', 20_000);
	expect(await app.text()).toContain('keeps crashing');
	await app.screenshot(`${dir}/page-crashed.png`);

	// It stays there: nothing reloads it behind the user's back.
	await Bun.sleep(5000);
	expect(await app.eval('location.pathname')).toBe('/__desktop/page-crashed');

	// The link goes back through the gate (a SameSite=Strict cookie, from a page of the same origin).
	await app.click('a');
	await app.waitFor('#counter', { timeout: 20_000 });
	expect(await app.eval('location.pathname')).toBe('/');
	await app.close();
}, 180_000);
