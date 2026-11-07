/**
 * Two dev lanes:
 *
 *   startNativeHost   — `vite dev`: spawn the Bun ModuleRunner host once;
 *                       the 'native' environment feeds it hmr over ws and
 *                       it applies updates in place (no rebuild, no restart).
 *   createDevSession  — dev.js standalone CLI: no vite server to run a
 *                       transport, so it keeps the build→spawn→restart loop.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { buildNativeApp } from './emit.js';
import { PKG_DIR } from './paths.js';

/**
 * Supervised spawn of runtime/host.js — the Bun-side ModuleRunner that
 * connects to the 'native' env's ws channel. Respawns on unexpected exit
 * (e.g. a crash evaluating user code) so the next update can still land.
 *
 * @param {object} opts
 *   root — app root (cwd + SVELTE_NATIVE_ROOT)
 *   env  — extra env for the child (SVELTE_NATIVE_DEVJSON)
 *   log  — status logger
 */
export function startNativeHost({ root, env = {}, log = console.log }) {
	let child = null;
	let disposed = false;
	let retry = null;
	let failures = 0;
	let lastSpawn = 0;

	const spawnHost = () => {
		if (disposed) return;
		lastSpawn = Date.now();
		child = spawn('bun', [join(PKG_DIR, 'runtime/host.js')], {
			cwd: root,
			stdio: 'inherit',
			env: { ...process.env, ...env },
		});
		child.on('error', (e) => {
			// spawn itself failed (bun not on PATH, EACCES, …) — the exit
			// handler won't fire, so log once and stop the retry loop
			child = null;
			log(`[svelte-native] host spawn failed: ${e.message}`);
		});
		child.on('exit', (code, sig) => {
			child = null;
			if (disposed || sig === 'SIGTERM') return;
			// clean exit — the window was closed intentionally (tick() →
			// running=false → exit(0)). Don't respawn; the user quit.
			if (code === 0) return;
			failures = Date.now() - lastSpawn < 3000 ? failures + 1 : 0;
			if (failures >= 8) { log('[svelte-native] host crash-looping — giving up'); return; }
			const delay = Math.min(800 * 2 ** Math.min(failures, 4), 8000);
			log(`[svelte-native] host exited (${code}) — respawning in ${delay}ms`);
			retry = setTimeout(spawnHost, delay);
		});
	};
	spawnHost();

	return {
		dispose() {
			disposed = true;
			clearTimeout(retry);
			child?.kill();
			child = null;
		},
	};
}

/**
 * @param {object} opts
 *   root          — app root (vite root)
 *   outDir        — emitted bundle dir, default '.svelte-native' (under root)
 *   dev           — compile Svelte in dev mode (SVELTE_NATIVE_DEV=1 for the build)
 *   vite          — overrides passed to vite build
 *   pluginOptions — forwarded to the fallback inline svelteNative() when the
 *                   app has no vite.config of its own
 *   entry opts    — title/width/height/startPath/backend/rendererClass/headless/hooks
 *   log           — status logger (default console.log)
 */
export function createDevSession({
	root,
	outDir = '.svelte-native',
	dev = true,
	vite: viteOverrides,
	pluginOptions,
	log = console.log,
	...entryOpts
}) {
	const outDirName = String(outDir);
	let child = null;
	let building = false;
	let queued = false;
	let timer = null;
	let disposed = false;

	function start(bundlePath) {
		child = spawn('bun', [bundlePath], { cwd: root, stdio: 'inherit' });
		child.on('exit', (code) => {
			if (child === null) return; // killed by restart/dispose
			log(`[svelte-native] app exited (${code})`);
			child = null;
		});
	}

	function restart(bundlePath) {
		if (disposed) return;
		if (child) {
			const old = child;
			child = null;
			old.kill();
			old.once('exit', () => start(bundlePath));
		} else start(bundlePath);
	}

	async function rebuild(reason) {
		if (disposed) return;
		if (building) {
			queued = true;
			return;
		}
		building = true;
		try {
			const { bundlePath } = await buildNativeApp({
				root,
				outDir,
				dev,
				vite: viteOverrides,
				pluginOptions,
				...entryOpts,
			});
			log(`[svelte-native] rebuilt (${reason}) → relaunching`);
			restart(bundlePath);
		} catch (e) {
			console.error(`[svelte-native] rebuild failed (${reason}) — keeping last good app:`, e?.message ?? e);
		} finally {
			building = false;
			if (queued && !disposed) {
				queued = false;
				rebuild('queued changes');
			}
		}
	}

	/** File-event entry point — debounces, ignores our own output + churn
	 *  that can't change the bundle (lockfiles, .svelte-kit leftovers, deps). */
	const IGNORE = /node_modules|\.svelte-kit|\.git|bun\.lock|bun\.lockb|package-lock|pnpm-lock/;
	function onFile(file) {
		if (!file || file.includes(outDirName) || IGNORE.test(file)) return;
		clearTimeout(timer);
		timer = setTimeout(() => rebuild(file), 120);
	}

	function dispose() {
		disposed = true;
		clearTimeout(timer);
		const old = child;
		child = null;
		old?.kill();
	}

	return { onFile, rebuild, dispose };
}
