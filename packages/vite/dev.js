#!/usr/bin/env bun
/**
 * svelte-native dev — standalone `bun dev` for the native app, for projects
 * that don't run `vite dev` (or want the window without the dev server).
 * The vite-plugin path is preferred: `vite dev` drives the same session
 * from configureServer — see vite-plugin.js.
 *
 *   bun packages/svelte-native/dev.js [appRoot] [same flags as build.js]
 *
 * Loop: buildNativeApp → spawn `bun .svelte-native/app.js` → on source
 * change, rebuild and RESTART the process (see dev-session.js for why
 * restart is the correct seam over in-process remount).
 */
import { existsSync, watch as fsWatch } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createDevSession } from './dev-session.js';
import { GPUIX_PKG, SVELTE_PKG } from './paths.js';

const args = process.argv.slice(2);
const opts = {};
let root = null;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--outDir') opts.outDir = args[++i];
	else if (a === '--backend') opts.backend = args[++i];
	else if (a === '--renderer') opts.rendererClass = args[++i];
	else if (a === '--headless') opts.headless = true;
	else if (a === '--title') opts.title = args[++i];
	else if (a === '--width') opts.width = Number(args[++i]);
	else if (a === '--height') opts.height = Number(args[++i]);
	else if (a === '--path') opts.startPath = args[++i];
	else if (a === '--routes') opts.pluginOptions = { ...opts.pluginOptions, routesDir: args[++i] };
	else if (a === '--params') opts.pluginOptions = { ...opts.pluginOptions, paramsDir: args[++i] };
	else if (a === '--once') opts.once = true;
	else if (!a.startsWith('--') && !root) root = a;
	else {
		console.error(`unknown arg: ${a}`);
		process.exit(1);
	}
}
root = resolvePath(root ?? process.cwd());
const outDirName = opts.outDir ?? '.svelte-native';

const { pluginOptions, vite, once, outDir, ...entryOpts } = opts;
const session = createDevSession({
	root,
	outDir: outDirName,
	dev: true,
	pluginOptions,
	vite,
	...entryOpts,
});

// initial build + launch
try {
	await session.rebuild('initial');
} catch (e) {
	console.error('[svelte-native] initial build failed:', e);
	process.exit(1);
}
if (once) process.exit(0);

// watch the authored app + the native stack it compiles against
const WATCH_DIRS = [join(root, 'src'), join(GPUIX_PKG, 'src'), SVELTE_PKG];
for (const dir of WATCH_DIRS) {
	if (!existsSync(dir)) continue;
	try {
		fsWatch(dir, { recursive: true }, (_ev, file) => session.onFile(file && join(dir, file)));
		console.log(`[svelte-native] watching ${dir}`);
	} catch {
		// fs.watch recursive unsupported (linux) — fall back to chokidar,
		// which ships with every vite install
		import('chokidar')
			.then(({ watch }) => {
				watch(dir, { ignoreInitial: true }).on('all', (_e, f) => session.onFile(f));
				console.log(`[svelte-native] watching ${dir} (chokidar)`);
			})
			.catch(() => console.warn(`[svelte-native] cannot watch ${dir} — restart manually`));
	}
}

const shutdown = () => {
	session.dispose();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
