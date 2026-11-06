// A real update on macOS or Windows, from what packages/shell/test/update-real/build.sh built: an
// installed 0.1.0 checks a signed feed, downloads, applies and relaunches through the helper, and
// what runs after is asked for its version. Unsigned: signing takes real certificates.
//   UPDATE_E2E=<work dir> bun test --timeout 180000 tests/update-real.test.ts
// Skipped unless UPDATE_E2E is set (CI: .github/workflows/update-test.yml).
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defaultDataDir } from '../../../packages/shell/src/updater/platform.ts';

const W = process.env.UPDATE_E2E ?? '';
const WINDOWS = process.platform === 'win32';
const OS = WINDOWS ? 'windows' : 'darwin';
const PORT = 47992;
const built = (dir: string) => join(W, dir, WINDOWS ? 'app' : 'app.app');
// Under a name of the user's, not the release's.
const target = join(W, 'installed', WINDOWS ? `Arnaud's Notes` : `Arnaud's Notes.app`);
const probeFile = join(W, 'probe.log');
const dataDir = defaultDataDir('dev.kitop.notes', OS);
const statePath = join(dataDir, 'state.json');
const helperPath = join(dataDir, 'helper.log');

const probe = () => (existsSync(probeFile) ? readFileSync(probeFile, 'utf8') : '');
const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null);
const helperLog = () => (existsSync(helperPath) ? readFileSync(helperPath, 'utf8') : '(no helper log)');

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

async function until(what: string, fn: () => unknown, ms = 90_000) {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}\nprobe: ${probe()}\nstate: ${JSON.stringify(state())}\nhelper: ${helperLog()}`);
		await Bun.sleep(200);
	}
}

// By its exact name, and only on a CI runner: UPDATE_E2E is never set elsewhere.
function stopApp() {
	if (WINDOWS) Bun.spawnSync(['taskkill', '/F', '/IM', 'SvelteNotes.exe']);
	else Bun.spawnSync(['pkill', '-9', '-x', 'SvelteNotes']);
}

describe.skipIf(!W)('a real update', () => {
	afterAll(stopApp);

	test('0.1.0 checks, downloads, applies 0.2.0, relaunches, and 0.2.0 is what runs', async () => {
		rmSync(join(W, 'installed'), { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(probeFile, { force: true });
		mkdirSync(join(W, 'installed'), { recursive: true });
		cpSync(built('a'), target, { recursive: true, verbatimSymlinks: true });
		expect(contents(built('b'))).not.toEqual(contents(built('a')));

		const hits: string[] = [];
		const feed = Bun.serve({
			hostname: '127.0.0.1',
			port: PORT,
			fetch(req) {
				const path = decodeURIComponent(new URL(req.url).pathname);
				hits.push(path);
				return new Response(Bun.file(join(W, 'feed-b', path)));
			},
		});
		try {
			Bun.spawn([executable(target)], {
				cwd: W,
				stdout: 'ignore',
				stderr: 'ignore',
				env: { ...process.env, NOTES_UPDATE_PROBE: '1', NOTES_UPDATE_PROBE_LOG: probeFile },
			});
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
		} finally {
			feed.stop(true);
		}
	}, 180_000);
});
