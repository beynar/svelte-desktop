// An update on a real packaged app (examples/notes, built with an `update` config by e2e.sh): the
// launch counts first, a page confirms, and a version that keeps dying before one is replaced by
// the previous one, which then starts. The swap itself is in src/updater/apply.test.ts.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from '@kitop/shell/test';
import { appDirs } from '../../src/os.ts';
import { defaultDataDir } from '../../src/updater/platform.ts';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const dataDir = defaultDataDir('dev.kitop.notes', 'linux');
const statePath = join(dataDir, 'state.json');
const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null);
const root = '/tmp/update-rollback';

function applied() {
	mkdirSync(root, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(`${root}/installed`, 'new');
	writeFileSync(`${root}/installed.old`, 'old');
	writeFileSync(
		statePath,
		JSON.stringify({
			from: '0.0.9',
			to: version,
			attempts: 0,
			platform: 'linux',
			phase: 'applied',
			moves: [{ src: `${root}/src`, dest: `${root}/installed`, backup: `${root}/installed.old`, existed: true }],
			stagingDir: `${root}/staging`,
			updatedAt: new Date().toISOString()
		})
	);
}

function executable() {
	const dir = resolve('.desktop/dist/Svelte Notes');
	const entry = readdirSync(dir).find((f) => f.endsWith('.desktop'))!;
	return join(dir, /^Exec=(\S+)/m.exec(readFileSync(join(dir, entry), 'utf8'))![1]!);
}

// pkill returns before the process is gone. Until it is, its single-instance lock sends the next launch away.
async function killApp() {
	Bun.spawnSync(['pkill', '-9', '-f', executable()]);
	for (let i = 0; i < 200 && Bun.spawnSync(['pgrep', '-f', executable()]).exitCode === 0; i++) await Bun.sleep(25);
}

afterAll(async () => {
	await killApp();
	rmSync(statePath, { force: true });
	rmSync(root, { recursive: true, force: true });
});

test('healthy: counted at launch, not confirmed at once, confirmed once a page has stayed up', async () => {
	applied();
	const app = await launch({});
	expect(state()?.attempts).toBe(1);
	await app.waitFor('#counter');
	expect(state()?.phase).toBe('applied');
	for (let i = 0; i < 100 && state(); i++) await Bun.sleep(100);
	expect(state()).toBeNull();
	expect(existsSync(`${root}/installed.old`)).toBe(false);
	await app.close();
}, 60_000);

test('dying before a page, twice: the previous version comes back and starts', async () => {
	applied();
	const first = Bun.spawn([executable()], { stdout: 'ignore', stderr: 'ignore' });
	for (let i = 0; i < 1000 && state()?.attempts !== 1; i++) await Bun.sleep(5); // counted, and no page yet
	first.kill(9);
	await first.exited;
	expect(state()?.attempts).toBe(1);
	expect(state()?.phase).toBe('applied');

	const second = Bun.spawn([executable()], { stdout: 'ignore', stderr: 'ignore' });
	expect(await second.exited).toBe(0);
	await Bun.sleep(1500);
	expect(state()?.phase).toBe('rolled-back');
	expect(readFileSync(`${root}/installed`, 'utf8')).toBe('old');
	const processes = await new Response(Bun.spawn(['ps', '-eo', 'args'], { stdout: 'pipe' }).stdout).text();
	expect(processes.split('\n').some((l) => l.startsWith(executable()))).toBe(true);
	await killApp();
}, 60_000);

test('a server that dies at startup, on its own: its restarts count, and the previous version comes back', async () => {
	applied();
	rmSync(join(appDirs('dev.kitop.notes').data, '.crash-restarts'), { force: true });
	// crash-probe.ts: nobody starts it again but the app itself.
	Bun.spawn([executable()], { env: { ...process.env, CRASH_HOW: 'import' }, stdout: 'ignore', stderr: 'ignore' });
	for (let i = 0; i < 300 && state()?.phase !== 'rolled-back'; i++) await Bun.sleep(100);
	expect(state()?.phase).toBe('rolled-back');
	expect(readFileSync(`${root}/installed`, 'utf8')).toBe('old');
	Bun.spawnSync(['pkill', '-9', '-f', executable()]);
	rmSync(join(appDirs('dev.kitop.notes').data, '.crash-restarts'), { force: true });
	rmSync(join(appDirs('dev.kitop.notes').data, '.last-error'), { force: true });
}, 60_000);

test('a packaged app ignores what points dev at other code', async () => {
	const app = await launch({ env: { KITOP_LIB: '/nonexistent/libshell.so', KITOP_ADDONS: '{"x":"/nonexistent"}' } });
	await app.waitFor('#counter');
	await app.close();
}, 60_000);
