/**
 * build-app.ts — compile the REAL app (../app/src) into src/gen-app/ so the
 * kit runtime (src/kit → src/gen/kit) can boot it inside the native window.
 *
 * This is the app-targeted sibling of build.ts: same svelte compile +
 * specifier rewrites + manifest emit, parameterized on the app dir instead of
 * src/routes. The app stays in place; nothing here touches build.ts or the
 * poc's own route pipeline. The vite-plugin workstream will replace this
 * transport-side compile later — the runtime contract it feeds is identical.
 *
 * Specifier mapping applied to app code:
 *   $app/server        → src/app-compat/server.js (remote fns + request scope, in-process)
 *   $app/<other>       → #kit (gen/kit/index.js — navigation/state/forms/paths/environment)
 *   #lib/x, $lib/x     → app/gen-app/lib/<x> (app's own lib, vendored below)
 *   ./x.ts relative    → compiled sibling names
 *   <asset>.svg|png|…  → emitted `.js` stub exporting the file's absolute path
 *   svelte / svelte/*  → client entries (same rules as build.ts)
 *
 * Route-module output names keep the source extension in the emitted name —
 * `+page.ts` → `+page.ts.js` — so it can never collide with `+page.svelte` →
 * `+page.js`. `ssr=false` semantics: client compile only, no html shell.
 *
 * Run: `bun packages/svelte/build-app.ts` (also auto-run by app/main-app.ts).
 */
import { compile, compileModule } from 'svelte/compiler';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';

const POC = import.meta.dir; // …/packages/svelte
const ROOT = join(POC, '..', '..');
const SRC = POC; // kit/, app-compat/ live at the package root
const NM = join(ROOT, 'app', 'node_modules'); // app's own install — svelte lives here
const APP_SRC = join(ROOT, 'app', 'src');
const APP_ROUTES = join(APP_SRC, 'routes');
const APP_LIB = join(APP_SRC, 'lib');
const APP_PARAMS = join(APP_SRC, 'params');
const GEN = join(POC, 'gen');
const GEN_APP = join(ROOT, 'app', 'gen-app');
const tsx = new Bun.Transpiler({ loader: 'ts' });

function* walk(dir: string): Generator<string> {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) yield* walk(p);
		else yield p;
	}
}

// ── emitted-name rules (shared by emit + alias resolution + manifest) ──────
// .svelte/.svelte.js/.svelte.ts → strip to .js (build.ts convention);
// .ts → .ts.js (never collides with a .svelte sibling); assets → `.js` stub.
const emitName = (rel: string): string =>
	/\.svelte(\.[jt]s)?$/.test(rel)
		? rel.replace(/\.svelte(\.[jt]s)?$/, '.js')
		: rel.endsWith('.ts')
			? rel + '.js'
			: rel.endsWith('.js')
				? rel
				: rel + '.js';

const ASSET_EXT = /\.(svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|mp4|webm|txt|json)$/i;

/** `$app/*` modules the in-process runtime covers via #kit (superset). */
const KNOWN_APP_MODULES = new Set([
	'$app/navigation',
	'$app/state',
	'$app/stores',
	'$app/forms',
	'$app/paths',
	'$app/environment',
]);

// ── svelte client rewrites (identical intent to build.ts) ───────────────────
const SVELTE_CLIENT: Record<string, string> = {
	'svelte/store': 'svelte/src/store/index-client.js',
	'svelte/reactivity': 'svelte/src/reactivity/index-client.js',
	'svelte/legacy': 'svelte/src/legacy/legacy-client.js',
};

function svelteSubpath(spec: string): string | null {
	if (SVELTE_CLIENT[spec]) return SVELTE_CLIENT[spec];
	const sub = spec.slice('svelte/'.length);
	try {
		if (statSync(join(NM, 'svelte/src', sub, 'index-client.js')).isFile())
			return `svelte/src/${sub}/index-client.js`;
	} catch {}
	return null;
}

const relSpec = (fromDir: string, toAbs: string): string => {
	const r = relative(fromDir, toAbs).replaceAll('\\', '/');
	return r.startsWith('.') ? r : './' + r;
};

/** Resolve a `#lib/x`/`$lib/x` specifier to the emitted file under gen-app/lib.
 *  Probes the real app/src/lib so `#lib/data.remote` finds `data.remote.ts`
 *  → `lib/data.remote.ts.js`, and assets land on their `.js` stubs. */
function libTarget(rest: string): string {
	if (!rest) {
		for (const cand of ['index.ts', 'index.js']) if (existsSync(join(APP_LIB, cand))) return 'lib/' + emitName(cand);
		return 'lib/index.js';
	}
	for (const cand of [rest, `${rest}.ts`, `${rest}.js`, `${rest}.svelte`, `${rest}/index.ts`, `${rest}/index.js`])
		if (existsSync(join(APP_LIB, cand))) return 'lib/' + emitName(cand);
	return emitName('lib/' + rest); // asset or unknown → .js stub path
}

/** Resolve an extensionless/relative specifier against the importing file's
 *  source dir → emitted sibling name (`./x.ts.js` / `./x.js` / `./x.svg.js`). */
function relTarget(srcDir: string, spec: string): string | null {
	for (const cand of [spec, `${spec}.ts`, `${spec}.js`, `${spec}.svelte`, `${spec}/index.ts`, `${spec}/index.js`])
		if (existsSync(join(srcDir, cand))) return emitName(cand);
	return null;
}

/** All specifier rewrites for one emitted file.
 *  outAbs: absolute path of the emitted file (for relative-path math).
 *  srcDir: absolute dir of the SOURCE file (for probing relative imports).
 *  appSpace: apply $app/#lib/$lib mapping (app files), or only svelte/.svelte
 *  rewrites (kit runtime files). */
function rewriteSpecs(code: string, outAbs: string, srcDir: string, appSpace: boolean): string {
	const outDir = dirname(outAbs);

	// no css pipeline in gen — drop css imports (same as vendorDir)
	code = code.replace(/import\s+['"][^'"]+\.css['"];?/g, '');

	if (appSpace) {
		// $app/server → in-process remote+request shim; other $app/* → #kit
		code = code.replace(/(from\s+['"])(\$app\/[\w/-]+)(['"])/g, (m, q1, spec, q2) => {
			if (spec === '$app/server')
				return `${q1}@svelte-desktop/svelte/app-compat/server.js${q2}`;
			if (KNOWN_APP_MODULES.has(spec)) return `${q1}#kit${q2}`;
			console.log(`  ! unmapped specifier '${spec}' in ${relative(ROOT, outAbs)} — left as-is`);
			return m;
		});
		// #lib/* and $lib/* → gen-app/lib emitted targets
		code = code.replace(/(from\s+['"])([#$]lib)(\/[^'"]*)?(['"])/g, (_m, q1, _base, rest, q2) => {
			const t = libTarget(rest ? rest.slice(1) : '');
			return `${q1}${relSpec(outDir, join(GEN_APP, t))}${q2}`;
		});
	}

	// relative specifiers → emitted names: probe the importing file's source
	// dir so `./x`, `./x.ts`, `./x.svelte`, `./x.svg` all land on the emitted
	// sibling (`./x.ts.js`, `./x.js`, `./x.svg.js`). '../' specs probe the same
	// way — relTarget resolves them against the source tree and the emitted
	// name keeps the leading '..' hops.
	code = code.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, (m, q1, spec, q2) => {
		if (/\.js$/.test(spec)) return m; // already an emitted name
		const t = relTarget(srcDir, spec); // emitted rel path, './'/'../' prefix preserved
		if (!t) return spec.endsWith('.ts') ? `${q1}${spec}.js${q2}` : m;
		return `${q1}${t}${q2}`;
	});
	// .svelte/.svelte.js/.svelte.ts suffixes → .js
	code = code.replace(/(from\s+['"][^'"]+)\.svelte(?:\.[jt]s)?(['"])/g, '$1.js$2');

	// bare 'svelte' → client shim (package specifier); svelte/* subpaths →
	// client entry files inside the installed svelte package
	code = code.replace(/from\s+(['"])(svelte(?:\/[\w/-]*)?)\1/g, (m, q, spec) => {
		if (spec === 'svelte') return `from ${q}@svelte-desktop/svelte/svelte-client.js${q}`;
		const target = svelteSubpath(spec);
		return target ? `from ${q}${relSpec(outDir, join(NM, target))}${q}` : m;
	});
	return code;
}

/** Compile one app-space file (.svelte/.svelte.js/.svelte.ts/.ts/.js) and
 *  emit under `outRel` relative to GEN_APP. Assets emit a path-string stub. */
async function emitAppFile(srcAbs: string, outRel: string, srcDir: string) {
	const outAbs = join(GEN_APP, outRel);
	const src = await Bun.file(srcAbs).text();
	const isSvelte = srcAbs.endsWith('.svelte');
	const isRuneMod = /\.svelte\.[jt]s$/.test(srcAbs);
	const isTs = srcAbs.endsWith('.ts');
	let code: string;
	if (isSvelte)
		// the app's own vite config sets experimental.async globally — mirror it
		code = compile(src, {
			generate: 'client',
			filename: srcAbs,
			dev: false,
			css: 'injected',
			experimental: { async: true },
		}).js.code;
	else if (isRuneMod)
		code = compileModule(isTs ? tsx.transformSync(src) : src, {
			generate: 'client',
			filename: srcAbs,
			dev: false,
			experimental: { async: true },
		} as never).js.code;
	else if (isTs) code = tsx.transformSync(src);
	else code = src;
	code = rewriteSpecs(code, outAbs, srcDir, true);
	mkdirSync(dirname(outAbs), { recursive: true });
	await Bun.write(outAbs, code);
	console.log(`  app  ${relative(APP_SRC, srcAbs)} → app/gen-app/${outRel}`);
}

/** Emit an asset stub: `import favicon from '…favicon.svg'` gets a path string
 *  (no asset server in-process — head/link use the value as an opaque href). */
async function emitAssetStub(srcAbs: string, outRel: string) {
	const outAbs = join(GEN_APP, outRel);
	mkdirSync(dirname(outAbs), { recursive: true });
	await Bun.write(outAbs, `// asset stub — file kept in place, no bundler transport\nexport default ${JSON.stringify(srcAbs)};\n`);
	console.log(`  stub ${relative(APP_SRC, srcAbs)} → app/gen-app/${outRel}`);
}

// ── kit runtime: emit the 4 files the app boot consumes ─────────────────────
// Same compile + rewrites as build.ts's emit for these files (additive —
// build.ts still owns src/gen wholesale; this just keeps `bun app/main-app.ts`
// self-contained on a clean tree and picks up runtime source edits).
async function ensureKitRuntime() {
	for (const file of ['kit/Shell.svelte', 'kit/index.js', 'kit/runtime.svelte.js', 'remote.svelte.js']) {
		const srcAbs = join(SRC, file);
		const outRel = emitName(file); // kit/Shell.js, kit/index.js, kit/runtime.js, remote.js
		const outAbs = join(GEN, outRel);
		const src = await Bun.file(srcAbs).text();
		let code = file.endsWith('.svelte')
			? compile(src, { generate: 'client', filename: srcAbs, dev: false, css: 'injected' }).js.code
			: compileModule(file.endsWith('.ts') ? tsx.transformSync(src) : src, {
					generate: 'client',
					filename: srcAbs,
					dev: false,
				}).js.code;
		code = code.replaceAll('./remote.svelte.js', './remote.js').replaceAll('./remote.svelte.ts', './remote.js');
		code = rewriteSpecs(code, outAbs, dirname(srcAbs), false);
		mkdirSync(dirname(outAbs), { recursive: true });
		await Bun.write(outAbs, code);
		console.log(`  kit  ${file} → packages/svelte/gen/${outRel}`);
	}
}

// ── routes: scan the app's route dir (same file set as build.ts) ────────────
const ROUTE_FILES = [
	'+page.svelte',
	'+page.ts',
	'+page.server.ts',
	'+layout.svelte',
	'+layout.ts',
	'+layout.server.ts',
	'+error.svelte',
	'+server.ts',
];
/** dirs keyed by relative route path; '' = root */
const routeDirs = new Map<string, Set<string>>();
for (const p of walk(APP_ROUTES)) {
	const file = p.split('/').pop()!;
	if (!ROUTE_FILES.includes(file)) continue;
	const dir = relative(APP_ROUTES, dirname(p)).replaceAll('\\', '/');
	const key = dir === '.' ? '' : dir;
	if (!routeDirs.has(key)) routeDirs.set(key, new Set());
	routeDirs.get(key)!.add(file);
}

for (const [dir, files] of routeDirs) {
	for (const f of files) {
		const srcAbs = join(APP_ROUTES, dir, f);
		await emitAppFile(srcAbs, `routes/${dir ? dir + '/' : ''}${emitName(f)}`, dirname(srcAbs));
	}
}

// ── app lib → gen-app/lib (vendored: code compiles, assets become stubs) ────
if (existsSync(APP_LIB)) {
	for (const p of walk(APP_LIB)) {
		const rel = relative(APP_LIB, p).replaceAll('\\', '/');
		if (rel.endsWith('.d.ts') || rel.endsWith('.map')) continue;
		const isCode = /\.(svelte|svelte\.[jt]s|ts|js)$/.test(rel);
		if (!isCode) {
			if (ASSET_EXT.test(rel)) await emitAssetStub(p, emitName('lib/' + rel));
			else console.log(`  ! skipped unhandled lib file: ${rel}`);
			continue;
		}
		await emitAppFile(p, emitName('lib/' + rel), dirname(p));
	}
}

// ── app hooks → gen-app/hooks.js ────────────────────────────────────────────
// kit hook surfaces in one process: hooks.server.ts (handle/fetch/error/init),
// hooks.client.ts (init/error), hooks.ts (universal: reroute/transport).
{
	const hookImpls: string[] = [];
	for (const f of ['hooks.ts', 'hooks.js', 'hooks.server.ts', 'hooks.client.ts']) {
		const srcAbs = join(APP_SRC, f);
		if (!existsSync(srcAbs)) continue;
		const out = emitName(f);
		await emitAppFile(srcAbs, `hooks-impl/${out}`, dirname(srcAbs));
		hookImpls.push(`export * from './hooks-impl/${out}';`);
	}
	mkdirSync(GEN_APP, { recursive: true });
	await Bun.write(
		join(GEN_APP, 'hooks.js'),
		hookImpls.length ? hookImpls.join('\n') + '\n' : '// app has no hooks file\nexport {};\n',
	);
}

// ── generate the app manifest (gen-app/routes/manifest.js) ─────────────────
// same emitter shape as build.ts; module refs point at compiled gen-app files
const parentDir = (k: string) => k.split('/').slice(0, -1).join('/');
const ancestors = (k: string) => {
	const out = [''];
	const parts = k ? k.split('/') : [];
	for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
	return out;
};
const findErrorKey = (from: string): string | null => {
	for (let k = from; ; k = parentDir(k)) {
		if (routeDirs.get(k)?.has('+error.svelte')) return k;
		if (k === '') return null;
	}
};
const genPath = (key: string, file: string) => './' + (key ? `${key}/` : '') + emitName(file);

let n = 0;
const imports: string[] = [];
const impCache = new Map<string, string>();
const imp = (spec: string, def = true) => {
	const cacheKey = `${def}:${spec}`;
	if (impCache.has(cacheKey)) return impCache.get(cacheKey)!;
	const name = `M${n++}`;
	impCache.set(cacheKey, name);
	imports.push(def ? `import ${name} from '${spec}';` : `import * as ${name} from '${spec}';`);
	return name;
};
// ── app params → gen-app/params + matcher imports ───────────────────────────
const matcherEntries: string[] = [];
if (existsSync(APP_PARAMS)) {
	for (const f of readdirSync(APP_PARAMS).filter((f) => /\.(ts|js)$/.test(f))) {
		const srcAbs = join(APP_PARAMS, f);
		await emitAppFile(srcAbs, `params/${emitName(f)}`, dirname(srcAbs));
		matcherEntries.push(`  '${f.replace(/\.(ts|js)$/, '')}': ${imp(`../params/${emitName(f)}`, false)}.match`);
	}
}

/** emit {component?, load?, serverLoad?, actions?, boundaryError?} for one level */
const levelExpr = (dir: string, isPage: boolean, files: Set<string>) => {
	const compFile = isPage ? '+page.svelte' : '+layout.svelte';
	const parts: string[] = [];
	if (files.has(compFile)) parts.push(`component: ${imp(genPath(dir, compFile))}`);
	const loadFile = isPage ? '+page.ts' : '+layout.ts';
	const serverFile = isPage ? '+page.server.ts' : '+layout.server.ts';
	if (files.has(loadFile)) parts.push(`load: ${imp(genPath(dir, loadFile), false)}.load`);
	if (files.has(serverFile)) {
		const mod = imp(genPath(dir, serverFile), false);
		parts.push(`serverLoad: ${mod}.load`);
		if (isPage) parts.push(`actions: ${mod}.actions`);
	}
	const errKey = findErrorKey(isPage ? dir : parentDir(dir));
	if (errKey !== null) parts.push(`boundaryError: ${imp(genPath(errKey, '+error.svelte'))}`);
	return `{ ${parts.join(', ')} }`;
};

// (group) dirs contribute layouts/errors but no URL segment
const stripGroups = (k: string) => k.split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/');
const routeId = (k: string) => '/' + stripGroups(k);

const pageKeys = [...routeDirs.keys()]
	.filter((k) => routeDirs.get(k)!.has('+page.svelte'))
	.sort((a, b) => {
		const dyn = (s: string) => (s.match(/\[\[\.\.\.|\[\[|\[\.\.\.|\[/g) ?? []).length;
		const opt = (s: string) => (s.match(/\[\[/g) ?? []).length;
		return dyn(a) - dyn(b) || opt(a) - opt(b) || stripGroups(b).split('/').length - stripGroups(a).split('/').length;
	});

const layoutIndex = new Map<string, number>();
const layoutExprs: string[] = [];
const layoutLevel = (dir: string) => {
	if (!layoutIndex.has(dir)) {
		layoutIndex.set(dir, layoutExprs.length);
		layoutExprs.push(levelExpr(dir, false, routeDirs.get(dir)!));
	}
	return layoutIndex.get(dir)!;
};

const routeEntries = pageKeys.map((key) => {
	const layoutIdxs = ancestors(key)
		.filter(
			(d) =>
				routeDirs.get(d)?.has('+layout.svelte') ||
				routeDirs.get(d)?.has('+layout.ts') ||
				routeDirs.get(d)?.has('+layout.server.ts'),
		)
		.map((d) => layoutLevel(d));
	const errKey = findErrorKey(key);
	const pageExpr = levelExpr(key, true, routeDirs.get(key)!);
	const errExpr = errKey !== null ? `, error: ${imp(genPath(errKey, '+error.svelte'))}` : '';
	return `  { id: '${routeId(key)}', layouts: [${layoutIdxs.join(', ')}], page: ${pageExpr}${errExpr} }`;
});

const endpointEntries = [...routeDirs.keys()]
	.filter((k) => routeDirs.get(k)!.has('+server.ts'))
	.map((k) => `  '${routeId(k)}': ${imp(genPath(k, '+server.ts'), false)}`);

const manifest = `// generated by build-app.ts — do not edit\n${imports.join('\n')}\n\nconst __layouts = [\n  ${layoutExprs.join(',\n  ')}\n];\n\nexport const routes = [\n${routeEntries.join(',\n')}\n];\n\nfor (const r of routes) r.layouts = r.layouts.map((i) => __layouts[i]);\n\nexport const endpoints = {\n${endpointEntries.join(',\n')}\n};\n\nexport const matchers = {\n${matcherEntries.join(',\n')}\n};\n`;

mkdirSync(join(GEN_APP, 'routes'), { recursive: true });
await Bun.write(join(GEN_APP, 'routes/manifest.js'), manifest);
console.log(
	`app manifest: ${pageKeys.length} routes, ${endpointEntries.length} endpoints, ${matcherEntries.length} matchers → app/gen-app/routes/manifest.js`,
);

await ensureKitRuntime();
console.log('build-app done');
