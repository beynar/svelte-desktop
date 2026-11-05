/**
 * Shared path helpers for svelte-desktop-native.
 *
 * The native stack this plugin packages is split across two sibling
 * packages under <repo>/packages:
 *   packages/gpuix   — the fake-DOM bridge (src/gdom.ts), the mutation sink
 *                      (src/native.ts), native-css helpers (src/native-css)
 *                      and the Rust crate (native/)
 *   packages/svelte  — the kit-shaped client runtime (kit/runtime.svelte.js,
 *                      kit/Shell.svelte) and remote fns (remote.svelte.js)
 * Everything is referenced by absolute path — vite, rolldown and the
 * spawned bun all resolve them identically.
 */
import { dirname, join, resolve as resolvePath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export const PKG_DIR = dirname(fileURLToPath(import.meta.url));
/** <repo>/packages — the sibling-package parent. */
export const PACKAGES = resolvePath(PKG_DIR, '..');
/** <repo> root — for dev-server fs.allow etc. */
export const REPO_ROOT = resolvePath(PKG_DIR, '../..');
/** packages/gpuix — gdom, native bridge, native-css, the Rust crate. */
export const GPUIX_PKG = join(PACKAGES, 'gpuix');
/** packages/svelte — kit-shaped runtime + remote fns (sibling package). */
export const SVELTE_PKG = join(PACKAGES, 'svelte');

export const KIT_RUNTIME = join(SVELTE_PKG, 'kit/runtime.svelte.js');
export const KIT_SHELL = join(SVELTE_PKG, 'kit/Shell.svelte');
export const GDOM = join(GPUIX_PKG, 'src/gdom.ts');
export const NATIVE = join(GPUIX_PKG, 'src/native.ts');
export const NATIVE_CSS_PARSE = join(GPUIX_PKG, 'src/native-css/parse.ts');
export const NATIVE_CSS_REGISTER = join(GPUIX_PKG, 'src/native-css/register.ts');
export const REMOTE = join(SVELTE_PKG, 'remote.svelte.js');

/** The deployed @gpuix/native JS wrapper — the only complete copy in the
 *  repo right now is this package's e2e fixture (index.js + fresh .node).
 *  Resolved to an absolute path so emitted bundles load OUR built binary
 *  regardless of the app's node_modules. Revisit when the napi package gets
 *  a canonical home in the packages/ restructure. */
export const GPUIX_NATIVE = join(
	PKG_DIR,
	'test/fixtures/app/node_modules/@gpuix/native/index.js',
);
/** rolldown external matcher for the resolved GPUIX_NATIVE path — keeps
 *  `import '<abs>'` in the bundle instead of inlining the napi loader. */
export const GPUIX_NATIVE_EXTERNAL = /node_modules[\\/]@gpuix[\\/]native[\\/]/;

/**
 * Resolve the installed svelte package directory. Prefer the consumer app's
 * own copy (peer dependency — resolved relative to the vite root so an app
 * with its own node_modules wins), falling back to whatever this package can
 * see. Returns null when svelte isn't installed.
 */
export function resolveSvelteDir(root) {
	for (const base of [root, PKG_DIR]) {
		if (!base) continue;
		try {
			const req = createRequire(join(base, '__svelte_native_probe__.js'));
			return dirname(req.resolve('svelte/package.json'));
		} catch {}
	}
	return null;
}

/**
 * build.ts's `svelteSubpath()` — 'svelte/x' → the client entry inside the
 * svelte package when it ships one (store/reactivity/legacy and any
 * `src/<sub>/index-client.js`), else null so the default resolver (exports
 * map, browser condition) takes it.
 */
export function svelteClientSubpath(spec, svelteDir) {
	const SVELTE_CLIENT = {
		'svelte/store': 'src/store/index-client.js',
		'svelte/reactivity': 'src/reactivity/index-client.js',
		'svelte/legacy': 'src/legacy/legacy-client.js',
	};
	if (!svelteDir || !spec.startsWith('svelte/')) return null;
	if (SVELTE_CLIENT[spec]) return join(svelteDir, SVELTE_CLIENT[spec]);
	const sub = spec.slice('svelte/'.length);
	const candidate = join(svelteDir, 'src', sub, 'index-client.js');
	try {
		if (existsSync(candidate)) return candidate;
	} catch {}
	return null;
}

/**
 * Import specifier for an absolute file path inside emitted module code —
 * the absolute path itself. `/@fs/` and `/<root-rel>` specifiers are
 * dev-server protocols; rolldown can't load them in `vite build`. Absolute
 * paths resolve identically under vite, rolldown and the spawned bun.
 * `root` is retained for call-site compatibility.
 */
export function toImportSpecifier(absPath, _root) {
	const p = isAbsolute(absPath) ? absPath : resolvePath(absPath);
	return p.replaceAll('\\', '/');
}
