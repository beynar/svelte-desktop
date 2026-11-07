/**
 * bun test — plugin verification.
 *
 * Covers the spec's minimum: transform of a real .svelte fixture (compile +
 * import rewrites + stylesheet harvest → virtual module) and manifest
 * emission for a scratch routes tree. Hooks are invoked directly with a
 * minimal plugin context — no vite server needed.
 */
import { test, expect, describe } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelteNative, MANIFEST_ID } from '../vite-plugin.js';
import { generateManifest, scanRoutes, isRouteSurfaceFile } from '../manifest.js';
import { KIT_RUNTIME } from '../paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'app');
const routesAbs = join(appRoot, 'src/routes');
const paramsAbs = join(appRoot, 'src/params');

/** minimal rollup-ish plugin context for direct hook invocation */
const ctx = () => ({
	warnings: [],
	warn(m) {
		this.warnings.push(String(m));
	},
	error(m) {
		throw new Error(String(m));
	},
	addWatchFile() {},
	meta: {},
});

function makePlugin(env = { command: 'build' }) {
	const p = svelteNative();
	const conf = p.config.call(ctx(), { root: appRoot }, env) ?? {};
	p.configResolved.call(ctx(), { root: appRoot });
	return { plugin: p, conf };
}

const readFixture = (rel) => readFileSync(join(appRoot, rel), 'utf8');

describe('config() aliases', () => {
	const { conf } = makePlugin();
	const alias = conf.resolve?.alias ?? [];
	const find = (spec) =>
		alias.find((a) => (a.find instanceof RegExp ? a.find.test(spec) : a.find === spec))?.replacement;

	test('$app/* → runtime shims', () => {
		for (const [spec, file] of [
			['$app/state', 'state.js'],
			['$app/navigation', 'navigation.js'],
			['$app/environment', 'environment.js'],
			['$app/paths', 'paths.js'],
			['$app/forms', 'forms.js'],
			['$app/server', 'server.js'],
		]) {
			const target = find(spec);
			expect(target, spec).toBeTruthy();
			expect(target.endsWith(join('runtime', file))).toBe(true);
			expect(existsSync(target)).toBe(true);
		}
	});

	test("'svelte' → client entry; svelte/internal → src/internal", () => {
		const svelteEntry = find('svelte');
		expect(svelteEntry).toContain('index-client.js');
		expect(existsSync(svelteEntry)).toBe(true);
		const internal = find('svelte/internal/client');
		expect(internal).toContain(join('src', 'internal'));
	});

	test('@sveltejs/kit + #kit → kit shim', () => {
		for (const spec of ['@sveltejs/kit', '#kit']) {
			const target = find(spec);
			expect(target, spec).toContain('kit.js');
		}
	});
});

describe('transform()', () => {
	test('.svelte → client compile + style harvest + css strip', async () => {
		const { plugin } = makePlugin();
		const id = join(routesAbs, '+page.svelte');
		const res = await plugin.transform.call(ctx(), readFixture('src/routes/+page.svelte'), id);
		expect(res).toBeTruthy();
		const code = res.code;

		// svelte compile ran (client output)
		expect(code).toContain('svelte/internal/client');
		// authored `import { page } from '$app/state'` survives for the alias
		expect(code).toContain('$app/state');
		expect(code).toContain('$app/navigation');
		// <style> harvested → appended virtual stylesheet import
		expect(code).toContain('virtual:svelte-native-style?');
		expect(code).toContain(encodeURIComponent(id));
		// './chrome.css' side-effect import → rewritten to a stylesheet register import
		expect(code).not.toContain(`from './chrome.css'`);
		expect(code).not.toContain(`import './chrome.css'`);
		// relative .svelte import left for vite (NOT rewritten to .js — the
		// source file is the module under vite, unlike build.ts's gen/ emit)
		expect(code).toContain('./Card.svelte');
		// idempotence marker for double-registration safety
		expect(code).toContain('svelte-native:compiled');
	});

	test('.svelte.js → compileModule (runes lowered)', async () => {
		const { plugin } = makePlugin();
		const id = join(appRoot, 'src/counter.svelte.js');
		const res = await plugin.transform.call(ctx(), readFixture('src/counter.svelte.js'), id);
		expect(res).toBeTruthy();
		expect(res.code).not.toContain('$state('); // rune compiled away
		expect(res.code).toContain('svelte-native:compiled');
	});

	test('.svelte.ts → type-strip + compileModule', async () => {
		const { plugin } = makePlugin();
		const id = join(appRoot, 'src/counter.svelte.ts');
		const res = await plugin.transform.call(ctx(), readFixture('src/counter.svelte.ts'), id);
		expect(res).toBeTruthy();
		expect(res.code).not.toContain(': { n: number }');
	});

	test('kit runtime itself compiles through the .svelte.js path', async () => {
		const { plugin } = makePlugin();
		const file = KIT_RUNTIME;
		expect(existsSync(file)).toBe(true);
		const res = await plugin.transform.call(ctx(), readFileSync(file, 'utf8'), file);
		expect(res).toBeTruthy();
		expect(res.code).toContain('svelte-native:compiled');
	});
});

describe('resolveId', () => {
	test("missing './x.js' → x.svelte.js fallback (kit's runtime.js convention)", () => {
		const { plugin } = makePlugin();
		// packages/svelte/kit/Shell.svelte imports './runtime.js' — only
		// runtime.svelte.js exists on disk
		const kitDir = dirname(KIT_RUNTIME);
		const importer = join(kitDir, 'Shell.svelte');
		const res = plugin.resolveId.call(ctx(), './runtime.js', importer);
		expect(res).toBe(join(kitDir, 'runtime.svelte.js'));
	});

	test("'svelte/store' → client subpath inside the svelte package", () => {
		const { plugin } = makePlugin();
		const res = plugin.resolveId.call(ctx(), 'svelte/store', join(appRoot, 'src/x.js'));
		expect(res).toContain(join('svelte', 'src', 'store', 'index-client.js'));
	});

	test('virtual ids resolve to \\0 form', () => {
		const { plugin } = makePlugin();
		expect(plugin.resolveId.call(ctx(), MANIFEST_ID)).toBe('\0' + MANIFEST_ID);
		expect(plugin.resolveId.call(ctx(), 'virtual:svelte-native-style?abc')).toBe(
			'\0virtual:svelte-native-style?abc.sheet',
		);
	});
});

describe('virtual:svelte-native-style', () => {
	test('load() emits registerSheet(<id>, <rules>)', async () => {
		const { plugin } = makePlugin();
		const c = ctx();
		const id = join(routesAbs, 'Card.svelte');
		await plugin.transform.call(c, readFixture('src/routes/Card.svelte'), id);
		const vid = '\0virtual:svelte-native-style?' + encodeURIComponent(id) + '.sheet';
		const code = await plugin.load.call(c, vid);
		expect(code).toContain('registerSheet(');
		expect(code).toContain(JSON.stringify(id));
		expect(code).toContain('register.ts'); // shared helper import
	});

	test('imported .css file harvests into its own sheet', async () => {
		const { plugin } = makePlugin();
		const c = ctx();
		const id = join(routesAbs, '+page.svelte');
		await plugin.transform.call(c, readFixture('src/routes/+page.svelte'), id);
		const cssFile = join(routesAbs, 'chrome.css');
		const vid = '\0virtual:svelte-native-style?' + encodeURIComponent(cssFile) + '.sheet';
		const code = await plugin.load.call(c, vid);
		expect(code).toContain('registerSheet(');
		// parseStylesheet's NativeStyleRule shape: sel comps + decls
		expect(code).toContain('"chrome"');
		expect(code).toContain('decls');
	});
});

describe('manifest', () => {
	test('scanRoutes finds the fixture tree', () => {
		const dirs = scanRoutes(routesAbs);
		expect(dirs.get('')?.has('+page.svelte')).toBe(true);
		expect(dirs.get('(group)/g')?.has('+page.svelte')).toBe(true);
		expect(dirs.get('api/time')?.has('+server.ts')).toBe(true);
	});

	test('emitted manifest mirrors build.ts shape', () => {
		const code = generateManifest({ routesDir: routesAbs, paramsDir: paramsAbs, root: appRoot });

		// route ids — group stripped, specificity-sorted (static before dynamic before optional)
		const ids = [...code.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
		expect(ids).toContain('/');
		expect(ids).toContain('/about');
		expect(ids).toContain('/item/[id]');
		expect(ids).toContain('/opt/[[opt]]');
		expect(ids).toContain('/g'); // (group) contributes no URL segment
		expect(ids.indexOf('/about')).toBeLessThan(ids.indexOf('/item/[id]'));
		expect(ids.indexOf('/item/[id]')).toBeLessThan(ids.indexOf('/opt/[[opt]]'));

		// layouts: root + (group) deduped; /g references both
		expect(code).toContain('const __layouts');
		expect(code).toContain('load: M');
		// +error.svelte boundary + per-route error
		expect(code).toContain('boundaryError');
		expect(code).toContain('error: M');
		// endpoint + matcher maps
		expect(code).toContain("'/api/time'");
		expect(code).toContain("'hex':");
		expect(code).toContain('.match');
		// imports are emitted as absolute fs specifiers — /@fs/ and root-rel
		// are dev-server protocols rolldown can't load in `vite build`
		expect(code).toMatch(/import M\d+ from '[^']*\/src\/routes\/\+page\.svelte'/);
		expect(code).toMatch(/import \* as M\d+ from '[^']*\/src\/routes\/\+page\.ts'/);
	});

	test('emitted manifest code is syntactically valid js', () => {
		const code = generateManifest({ routesDir: routesAbs, paramsDir: paramsAbs, root: appRoot });
		// parse check — throws on malformed emission
		new Bun.Transpiler({ loader: 'js' }).transformSync(code);
	});

	test('load() serves the manifest through the virtual id', async () => {
		const { plugin } = makePlugin();
		const code = await plugin.load.call(ctx(), '\0' + MANIFEST_ID);
		expect(code).toContain('export const routes');
		expect(code).toContain('export const endpoints');
		expect(code).toContain('export const matchers');
	});
});

describe('watcher surface', () => {
	test('isRouteSurfaceFile filters manifest-affecting files', () => {
		expect(isRouteSurfaceFile(join(routesAbs, '+page.svelte'), routesAbs, paramsAbs)).toBe(true);
		expect(isRouteSurfaceFile(join(routesAbs, 'x/+server.ts'), routesAbs, paramsAbs)).toBe(true);
		expect(isRouteSurfaceFile(join(routesAbs, 'README.md'), routesAbs, paramsAbs)).toBe(false);
		expect(isRouteSurfaceFile(join(paramsAbs, 'hex.ts'), routesAbs, paramsAbs)).toBe(true);
		expect(isRouteSurfaceFile(join(appRoot, 'src/app.html'), routesAbs, paramsAbs)).toBe(false);
	});
});
