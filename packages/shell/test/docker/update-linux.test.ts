// Real updates on Linux, from what test/docker/update.sh built and published: an installed 0.1.0
// checks a signed feed, downloads, applies and relaunches through the helper, and what runs after is
// asked for its version. Both for the app folder and the AppImage. Run as a normal user.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launch } from '@kitop/shell/test';
import { defaultDataDir } from '../../src/updater/platform.ts';

const W = '/tmp/update';
const PROBE = '/tmp/upd/probe.log'; // examples/notes/src/lib/server/update-probe.ts
const APPS = join(homedir(), 'Apps');
const dataDir = defaultDataDir('dev.kitop.notes', 'linux');
const statePath = join(dataDir, 'state.json');
const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null);
const probe = () => (existsSync(PROBE) ? readFileSync(PROBE, 'utf8') : '');
const running = () => Bun.spawnSync(['pgrep', '-x', 'svelte-notes']).exitCode === 0;
const helperLog = () => (existsSync(join(dataDir, 'helper.log')) ? readFileSync(join(dataDir, 'helper.log'), 'utf8') : '(no helper.log)');
const hasAppImage = existsSync(`${W}/a/app.AppImage`);
// A plain container has no FUSE: the runtime then unpacks instead of mounting. Same $APPIMAGE, same $APPDIR contract.
const appImageEnv: Record<string, string> = existsSync('/dev/fuse') ? {} : { APPIMAGE_EXTRACT_AND_RUN: '1' };

/** Everything that makes two installs the same: paths, modes, bytes. */
function digest(path: string): string {
	const hash = createHash('sha256');
	const walk = (p: string, rel: string) => {
		const st = lstatSync(p);
		hash.update(`${rel}\0${st.mode & 0o777}\0`);
		if (st.isSymbolicLink()) hash.update(readlinkSync(p));
		else if (st.isDirectory()) for (const name of readdirSync(p).sort()) walk(join(p, name), `${rel}/${name}`);
		else hash.update(readFileSync(p));
	};
	walk(path, '');
	return hash.digest('hex');
}

async function until(what: string, fn: () => unknown, timeoutMs = 60_000) {
	const end = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}\nprobe: ${probe()}\nstate: ${JSON.stringify(state())}\nhelper: ${helperLog()}`);
		await Bun.sleep(100);
	}
}

/** The static host: the directory a release was published to. */
function serve(dir: string) {
	const hits: string[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 47991,
		fetch(req) {
			const path = decodeURIComponent(new URL(req.url).pathname);
			hits.push(path);
			return new Response(Bun.file(join(W, dir, path)));
		}
	});
	return { hits, stop: () => server.stop(true) };
}

function start(exe: string, env: Record<string, string> = {}) {
	Bun.spawn([exe], { cwd: homedir(), stdout: 'ignore', stderr: 'ignore', env: { ...process.env, NOTES_UPDATE_PROBE: '1', ...appImageEnv, ...env } }).unref();
}

// Both installed under a name of the user's, not the release's.
const kinds = {
	folder: {
		target: join(APPS, `Arnaud's Notes`),
		exe: join(APPS, `Arnaud's Notes`, 'svelte-notes'),
		built: (v: string) => `${W}/${v}/folder`,
		system: '/opt/Svelte Notes',
		archive: /-linux-(x64|arm64)\.tar\.zst$/
	},
	appimage: {
		target: join(APPS, 'notes.AppImage'),
		exe: join(APPS, 'notes.AppImage'),
		built: (v: string) => `${W}/${v}/app.AppImage`,
		system: '/opt/notes.AppImage',
		archive: /-appimage-(x64|arm64)\.tar\.zst$/
	}
};

function install(kind: (typeof kinds)[keyof typeof kinds]) {
	rmSync(APPS, { recursive: true, force: true });
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(PROBE, { force: true });
	mkdirSync(APPS, { recursive: true });
	cpSync(kind.built('a'), kind.target, { recursive: true, verbatimSymlinks: true });
}

let feed: ReturnType<typeof serve> | undefined;
afterEach(async () => {
	feed?.stop();
	feed = undefined;
	// pkill returns before the process is gone. Until it is, its single-instance lock sends the next launch away.
	Bun.spawnSync(['pkill', '-9', '-x', 'svelte-notes']);
	for (let i = 0; i < 200 && running(); i++) await Bun.sleep(25);
});

for (const [name, kind] of Object.entries(kinds)) {
	describe.skipIf(name === 'appimage' && !hasAppImage)(name, () => {
		test('0.1.0 checks, downloads, applies 0.2.0, relaunches, and 0.2.0 is what runs', async () => {
			expect(digest(kind.built('b'))).not.toBe(digest(kind.built('a')));
			install(kind);
			// What an AppImage in the way hands down must not make the folder replace it (platform.ts).
			const other = join(APPS, 'Terminal.AppImage');
			writeFileSync(other, 'not ours');
			feed = serve('feed-b');
			start(kind.exe, name === 'folder' ? { APPIMAGE: other, APPDIR: '/tmp/.mount_other' } : {});

			await until('0.2.0 to run', () => probe().includes('started 0.2.0'));
			// Before its page has stayed up 5 s, which deletes the backup: hard links, to compare it after.
			const stateThen = state();
			const backup = `${APPS}/backup-then`;
			expect(Bun.spawnSync(['cp', '-al', `${kind.target}.old`, backup]).exitCode).toBe(0);
			expect(stateThen).toMatchObject({ phase: 'applied', from: '0.1.0', to: '0.2.0', attempts: 1 });
			await until('0.2.0 to find itself current', () => probe().includes('check none'));
			expect(running()).toBe(true);
			// Whole, byte for byte: nothing left of 0.1.0, through the delta patch for the folder.
			expect(digest(kind.target)).toBe(digest(kind.built('b')));
			expect(digest(backup)).toBe(digest(kind.built('a')));
			expect(feed.hits).toContain('/update.json');
			if (name === 'folder') {
				expect(feed.hits.some((h) => h.endsWith('.sdpatch'))).toBe(true);
				expect(feed.hits.some((h) => kind.archive.test(h))).toBe(false);
			} else {
				expect(feed.hits.some((h) => kind.archive.test(h))).toBe(true);
			}

			// A page stays up: healthy, and the backup goes.
			await until('the update to be confirmed', () => !state());
			expect(existsSync(`${kind.target}.old`)).toBe(false);
			expect(existsSync(`${kind.target}.new`)).toBe(false);
			expect(readFileSync(other, 'utf8')).toBe('not ours');
			if (name === 'appimage' && !appImageEnv.APPIMAGE_EXTRACT_AND_RUN) expect(Bun.spawnSync(['sh', '-c', 'grep -c "^[^ ]* /tmp/.mount_" /proc/mounts']).stdout.toString().trim()).not.toBe('0');
			expect(helperLog()).toContain('applied');
		});

		test('a 0.3.0 that crashes: 0.1.0 comes back at the next launch, and 0.3.0 is not offered again', async () => {
			install(kind);
			feed = serve('feed-c');
			start(kind.exe);

			// The helper relaunches it, it counts one start and dies before any page.
			await until('0.3.0 to count its first start', () => state()?.phase === 'applied' && state()?.attempts === 1);
			await until('0.3.0 to crash', () => !running());
			expect(digest(kind.target)).toBe(digest(kind.built('c')));
			expect(digest(`${kind.target}.old`)).toBe(digest(kind.built('a')));
			expect(probe()).toBe('started 0.1.0\ncheck 0.3.0\n');

			// The user starts it again: that second start restores 0.1.0 and hands over to it.
			start(kind.exe);
			await until('0.1.0 to run again', () => probe().includes('check none'));
			expect(probe()).toBe('started 0.1.0\ncheck none\n');
			expect(running()).toBe(true);
			expect(state()).toMatchObject({ phase: 'rolled-back', from: '0.1.0', to: '0.3.0', attempts: 2 });
			expect(digest(kind.target)).toBe(digest(kind.built('a')));
			expect(existsSync(`${kind.target}.old`)).toBe(false);
			expect(existsSync(`${kind.target}.bad`)).toBe(false);
		});

		test('in a directory this user cannot write to: not_writable, nothing downloaded or moved, the app still up', async () => {
			rmSync(dataDir, { recursive: true, force: true });
			const before = digest(kind.system);
			feed = serve('feed-b');
			const app = await launch({ app: kind.system, env: appImageEnv });
			try {
				await app.waitFor('#counter');
				const call = (op: string) => app.eval<{ status: number; body: any }>(`fetch('/__desktop/update/${op}', { method: 'POST' }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
				expect((await call('check')).body.version).toBe('0.2.0');
				const { status, body } = await call('install');
				expect(status).toBe(500);
				expect(body.code).toBe('not_writable');
				expect(body.message).toContain('/opt');
				expect(await app.eval('1 + 1')).toBe(2);
			} finally {
				await app.close();
			}
			expect(digest(kind.system)).toBe(before);
			expect(existsSync(`${kind.system}.old`)).toBe(false);
			expect(state()).toBeNull();
			expect(feed.hits.some((h) => h.endsWith('.tar.zst') || h.endsWith('.sdpatch'))).toBe(false);
		});
	});
}
