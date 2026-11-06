// A real update on macOS or Windows, from what packages/shell/test/update-real/build.sh built: an
// installed 0.1.0 checks a signed feed, downloads, applies and relaunches through the helper, and
// what runs after is asked for its version. Then a 0.3.0 that crashes, and the 0.1.0 that comes back.
// Unsigned: signing takes real certificates.
//   UPDATE_E2E=<work dir> bun test --timeout 180000 tests/update-real.test.ts
// Skipped unless UPDATE_E2E is set (CI: .github/workflows/update-test.yml).
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { appDirs } from '../../../packages/shell/src/os.ts';
import { defaultDataDir } from '../../../packages/shell/src/updater/platform.ts';

const W = process.env.UPDATE_E2E ?? '';
const WINDOWS = process.platform === 'win32';
const OS = WINDOWS ? 'windows' : 'darwin';
const PORT = 47992;
const built = (dir: string) => join(W, dir, WINDOWS ? 'app' : 'app.app');
// Under a name of the user's, not the release's.
const target = join(W, 'installed', WINDOWS ? `Éric's Notes` : `Arnaud's Notes.app`);
const probeFile = join(W, 'probe.log');
const dataDir = defaultDataDir('dev.kitop.notes', OS);
const statePath = join(dataDir, 'state.json');
const helperPath = join(dataDir, 'helper.log');

const probe = () => (existsSync(probeFile) ? readFileSync(probeFile, 'utf8') : '');
// Windows can refuse a read while the file is being replaced. That isn't the file being gone.
function state() {
	try {
		return JSON.parse(readFileSync(statePath, 'utf8'));
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { unreadable: String(e) };
	}
}
const helperLog = () => (existsSync(helperPath) ? readFileSync(helperPath, 'utf8') : '(no helper log)');
const appLogPath = join(appDirs('dev.kitop.notes').logs, 'app.log');
const appLog = () => (existsSync(appLogPath) ? readFileSync(appLogPath, 'utf8').slice(-2000) : '(no app log)');

function executable(app: string): string {
	if (WINDOWS) return join(app, readdirSync(app).find((f) => /\.exe$/i.test(f) && f !== 'Uninstall.exe')!);
	const dir = join(app, 'Contents/MacOS');
	const plist = readFileSync(join(app, 'Contents/Info.plist'), 'utf8');
	return join(dir, plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)![1]!);
}

/** Every file of an install and its hash (and its mode, where modes mean something). */
function contents(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (path: string) => {
		const st = lstatSync(path);
		if (st.isDirectory()) return readdirSync(path).forEach((name) => walk(join(path, name)));
		const hash = st.isSymbolicLink() ? 'link' : createHash('sha256').update(readFileSync(path)).digest('hex');
		out[relative(root, path).replaceAll('\\', '/')] = WINDOWS ? hash : `${st.mode & 0o777} ${hash}`;
	};
	walk(root);
	return out;
}

/** What runs, without the backups an update keeps next to it on Windows. */
const active = () => Object.fromEntries(Object.entries(contents(target)).filter(([file]) => !/^[^/]*\.old(\/|$)/.test(file)));

/** The backups of an update, each under the name it had. */
function kept(moves: { dest: string; backup: string }[]) {
	const out: Record<string, string> = {};
	for (const m of moves) for (const [file, hash] of Object.entries(contents(m.backup))) out[[relative(target, m.dest).replaceAll('\\', '/'), file].filter(Boolean).join('/')] = hash;
	return out;
}

async function until(what: string, fn: () => unknown, ms = 90_000) {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}\nprobe: ${probe()}\nstate: ${JSON.stringify(state())}\nhelper: ${helperLog()}\nnext to the install: ${readdirSync(join(W, 'installed'))}\nrunning: ${running()}\napp log: ${appLog()}`);
		await Bun.sleep(200);
	}
}

function running() {
	if (!WINDOWS) return Bun.spawnSync(['pgrep', '-x', 'SvelteNotes']).exitCode === 0;
	return Bun.spawnSync(['tasklist', '/FI', 'IMAGENAME eq SvelteNotes.exe', '/NH']).stdout.toString().includes('SvelteNotes.exe');
}

// By their exact names, and only on a CI runner: UPDATE_E2E is never set elsewhere. WebView2 too: it
// was started from the install folder, and keeps that folder from being deleted.
async function stopApp() {
	if (WINDOWS) {
		Bun.spawnSync(['taskkill', '/F', '/IM', 'SvelteNotes.exe']);
		Bun.spawnSync(['taskkill', '/F', '/IM', 'msedgewebview2.exe']);
	} else {
		Bun.spawnSync(['pkill', '-9', '-x', 'SvelteNotes']);
	}
	// Until it's gone, its single-instance lock sends the next launch away.
	for (let i = 0; i < 200 && running(); i++) await Bun.sleep(50);
}

/** 0.1.0 under the user's name, nothing left of an earlier run. */
function install() {
	rmSync(join(W, 'installed'), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	rmSync(probeFile, { force: true });
	for (const file of ['.crash-restarts', '.last-error', '.running']) rmSync(join(appDirs('dev.kitop.notes').data, file), { force: true });
	rmSync(appLogPath, { force: true });
	mkdirSync(join(W, 'installed'), { recursive: true });
	cpSync(built('a'), target, { recursive: true, verbatimSymlinks: true });
}

let feed: ReturnType<typeof Bun.serve> | undefined;
function serve(dir: string) {
	const hits: string[] = [];
	feed = Bun.serve({
		hostname: '127.0.0.1',
		port: PORT,
		fetch(req) {
			const path = decodeURIComponent(new URL(req.url).pathname);
			hits.push(path);
			return new Response(Bun.file(join(W, dir, path)));
		},
	});
	return hits;
}

function start(env: Record<string, string> = {}) {
	Bun.spawn([executable(target)], {
		cwd: W,
		stdout: 'ignore',
		stderr: 'ignore',
		env: { ...process.env, NOTES_UPDATE_PROBE: '1', NOTES_UPDATE_PROBE_LOG: probeFile, ...env },
	});
}

/** 0.1.0 runs again, whole, knows what happened, and doesn't take 0.3.0 again. */
async function broughtBack(hits: string[], stagingDir: string) {
	expect(state()).toMatchObject({ phase: 'rolled-back', from: '0.1.0', to: '0.3.0', attempts: 2 });
	expect(running()).toBe(true);
	console.log('[update] helper', helperLog());
	// Byte for byte, and nothing else on Windows, where the backups and the bad version lived next to it.
	expect(contents(target)).toEqual(contents(built('a')));
	expect(readdirSync(join(W, 'installed'))).toEqual([relative(join(W, 'installed'), target)]);
	expect(hits.filter((h) => h.endsWith('.tar.zst')).length).toBe(1);
	// Its page stays up: what's left of the update goes, and the state stays, so 0.3.0 stays skipped.
	await until('0.1.0 to clean up', () => !existsSync(stagingDir));
	expect(state()).toMatchObject({ phase: 'rolled-back', to: '0.3.0' });
}

describe.skipIf(!W)('a real update', () => {
	afterEach(async () => {
		feed?.stop(true);
		feed = undefined;
		await stopApp();
	});

	test('0.1.0 checks, downloads, applies 0.2.0, relaunches, and 0.2.0 is what runs', async () => {
		expect(contents(built('b'))).not.toEqual(contents(built('a')));
		install();
		const hits = serve('feed-b');
		start();
		await until('0.2.0 to run', () => probe().includes('started 0.2.0'));
		console.log('[update] feed asked for', hits);
		console.log('[update] state then', state());
		await until('0.2.0 to find itself current', () => probe().includes('check none'));
		expect(hits).toContain('/update.json');
		expect(hits.some((h) => h.endsWith('.sdpatch') || h.endsWith('.tar.zst'))).toBe(true);

		// A page stays up: healthy, and the backup goes.
		await until('the update to be confirmed', () => !state());
		expect(existsSync(`${target}.old`)).toBe(false);
		expect(existsSync(`${target}.new`)).toBe(false);
		console.log('[update] helper', helperLog());
		// Whole, byte for byte: nothing left of 0.1.0.
		expect(contents(target)).toEqual(contents(built('b')));
		expect(statSync(executable(target)).size).toBeGreaterThan(0);
	}, 180_000);

	test('a 0.3.0 that crashes at once: 0.1.0 comes back at the next launch', async () => {
		expect(contents(built('c'))).not.toEqual(contents(built('b')));
		install();
		const hits = serve('feed-c');
		start();

		// The helper relaunches it, it counts one start and dies before any page.
		await until('0.3.0 to count its first start', () => state()?.phase === 'applied' && state()?.attempts === 1);
		await until('0.3.0 to crash', () => !running());
		const { moves, stagingDir } = state();
		expect(active()).toEqual(contents(built('c')));
		expect(kept(moves)).toEqual(contents(built('a')));
		expect(probe()).toBe('started 0.1.0\ncheck 0.3.0\n');

		// The user starts it again: that second start restores 0.1.0 and hands over to it.
		start();
		await until('0.1.0 to run again', () => probe().includes('check none'));
		expect(probe()).toBe('started 0.1.0\ncheck none\n');
		await broughtBack(hits, stagingDir);
	}, 180_000);

	test('a 0.3.0 whose server dies while it loads: the app restarts itself, and 0.1.0 comes back', async () => {
		install();
		const hits = serve('feed-c');
		let stagingDir = '';
		start({ NOTES_UPDATE_CRASH: 'throw' });
		await until('0.3.0 to be applied', () => (stagingDir = state()?.stagingDir ?? ''));
		// On macOS the app restarts itself through `open`, without this test's environment: no probe to
		// ask, so what says 0.1.0 runs is what it does once its page is up.
		await until('0.1.0 to come back, with nobody starting anything', () => state()?.phase === 'rolled-back' && !existsSync(stagingDir));
		if (WINDOWS) await until('0.1.0 to answer', () => probe().includes('check none'));
		await broughtBack(hits, stagingDir);
	}, 180_000);

	// Not an update: 0.3.0 as it is, and nothing to go back to. macOS restarts it through `open`, which
	// passes on launchd's environment, not this test's.
	test('a server that keeps dying: a few restarts, then the app says so and stops trying', async () => {
		install();
		rmSync(target, { recursive: true, force: true });
		cpSync(built('c'), target, { recursive: true, verbatimSymlinks: true });
		if (!WINDOWS) Bun.spawnSync(['launchctl', 'setenv', 'NOTES_UPDATE_CRASH', 'throw']);
		try {
			const restarts = join(appDirs('dev.kitop.notes').data, '.crash-restarts');
			const count = () => (existsSync(restarts) ? JSON.parse(readFileSync(restarts, 'utf8')).length : 0);
			let most = 0;
			start({ NOTES_UPDATE_CRASH: 'throw' });
			await until('the restarts to stop', () => {
				most = Math.max(most, count());
				return most === 3 && count() === 0;
			});
			expect(existsSync(join(appDirs('dev.kitop.notes').data, '.last-error'))).toBe(true);
			// On screen for the user to read, and not going anywhere: no restart behind it.
			// tasklist's other columns change by themselves: its memory use, for one.
			const pids = () =>
				(WINDOWS ? Bun.spawnSync(['tasklist', '/FI', 'IMAGENAME eq SvelteNotes.exe', '/NH', '/FO', 'CSV']).stdout.toString().trim().split('\n').map((line) => line.split(',')[1]) : Bun.spawnSync(['pgrep', '-x', 'SvelteNotes']).stdout.toString().trim().split('\n')).join();
			await until('the last one to be the only one', () => pids() && !pids().includes(','));
			const shown = pids();
			await Bun.sleep(6000);
			expect(pids()).toBe(shown);
			expect(count()).toBe(0);
			if (WINDOWS) {
				// The dialog belongs to the main window, whose title is what the process reports as its own.
				const script = `Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes; $a = [System.Windows.Automation.AutomationElement]; $p = New-Object System.Windows.Automation.PropertyCondition($a::ProcessIdProperty, ${Number(shown.replaceAll('"', ''))}); $a::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $p) | ForEach-Object { $_.Current.Name }`;
				const names = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60_000 }).stdout.toString();
				expect(names).toContain('stopped working');
			}
		} finally {
			if (!WINDOWS) Bun.spawnSync(['launchctl', 'unsetenv', 'NOTES_UPDATE_CRASH']);
		}
	}, 180_000);
});
