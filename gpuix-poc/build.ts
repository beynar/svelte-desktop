import { compile, compileModule } from 'svelte/compiler';
import { mkdirSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

mkdirSync('src/gen/cases', { recursive: true });

const caseFiles = readdirSync('src/cases')
	.filter((f) => f.endsWith('.svelte'))
	.map((f) => `cases/${f}`);

// ── routes: scan src/routes for kit-style files ─────────────────────────────
function* walk(dir) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) yield* walk(p);
		else yield p;
	}
}
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
const routeDirs = new Map();
for (const p of walk('src/routes')) {
	const file = p.split('/').pop();
	if (!ROUTE_FILES.includes(file)) continue;
	const dir = relative('src/routes', p.split('/').slice(0, -1).join('/') || '.');
	const key = dir === '.' ? '' : dir;
	if (!routeDirs.has(key)) routeDirs.set(key, new Set());
	routeDirs.get(key).add(file);
}
// compile every +*.svelte in routes + kit internals into gen/
const routeSvelte = [...routeDirs.entries()].flatMap(([dir, files]) =>
	[...files]
		.filter((f) => f.endsWith('.svelte'))
		.map((f) => (dir ? `routes/${dir}/${f}` : `routes/${f}`)),
);
const kitFiles = readdirSync('src/kit').map((f) => `kit/${f}`);

// These svelte subpaths resolve to *server* entries under Bun (no `browser`
// condition) — rewrite imports to the client entry inside node_modules.
const SVELTE_CLIENT: Record<string, string> = {
	'svelte/store': 'svelte/src/store/index-client.js',
	'svelte/reactivity': 'svelte/src/reactivity/index-client.js',
	'svelte/legacy': 'svelte/src/legacy/legacy-client.js',
};

for (const file of [
	'App.svelte',
	'App2.svelte',
	'remote.svelte.js',
	...caseFiles,
	...routeSvelte,
	...kitFiles,
]) {
	const src = await Bun.file(`src/${file}`).text();
	try {
		const out = file.endsWith('.svelte')
			? compile(src, { generate: 'client', filename: `src/${file}`, dev: false, css: 'injected' })
			: compileModule(src, { generate: 'client', filename: `src/${file}`, dev: false });
		let code = out.js.code;
		code = code
			.replaceAll('./remote.svelte.js', './remote.js')
			.replaceAll('./remote.svelte.ts', './remote.js')
			.replaceAll('./server.ts', '../server.ts');
		// relative .svelte/.svelte.js imports → their compiled .js output
		code = code.replace(/(from\s+['"][^'"]+)\.svelte(?:\.[jt]s)?(['"])/g, '$1.js$2');
		const outName = file.replace(/\.svelte(\.[jt]s)?$/, '.js');
		// bare 'svelte' imports → client shim; svelte/* subpaths → client entry.
		// depth-aware relative paths (gen/x.js → ../, gen/cases/x.js → ../../)
		const depth = outName.includes('/') ? outName.split('/').length : 0;
		const rel = depth ? '../'.repeat(depth) + 'svelte-client.js' : './svelte-client.js';
		const nm = '../'.repeat(depth + 1) + 'node_modules/';
		code = code.replace(/from\s+(['"])(svelte(?:\/[\w/-]*)?)\1/g, (m, q, spec) => {
			if (spec === 'svelte') return `from ${q}${rel}${q}`;
			const target = SVELTE_CLIENT[spec];
			return target ? `from ${q}${nm}${target}${q}` : m;
		});
		mkdirSync(`src/gen/${outName.split('/').slice(0, -1).join('/')}`, { recursive: true });
		await Bun.write(`src/gen/${outName}`, code);
		console.log(`compiled ${file} → src/gen/${outName}`);
	} catch (e) {
		console.log(`FAILED ${file}:`, String(e).split('\n')[0]);
		throw e;
	}
}

// ── vendor: compile .svelte/.svelte.{js,ts}/.ts sources from arbitrary dirs ──
// (node_modules packages like svelte-streamdown ship .svelte sources Bun can't
// load; src/shadcn + src/dashboard go through the same path). Emits into
// src/gen with the same svelte-client rewrites as first-party files.
const tsx = new Bun.Transpiler({ loader: 'ts' });

function svelteSubpath(spec: string): string | null {
	// 'svelte/x' → client entry inside node_modules when the package ships a
	// browser-conditional export (store/reactivity/legacy); other subpaths
	// (events/motion/…) resolve to src files that pull internal/client — fine
	if (SVELTE_CLIENT[spec]) return SVELTE_CLIENT[spec];
	const sub = spec.slice('svelte/'.length);
	try {
		if (statSync(`node_modules/svelte/src/${sub}/index-client.js`).isFile())
			return `svelte/src/${sub}/index-client.js`;
	} catch {}
	return null;
}

async function vendorDir(srcRoot: string, outRoot: string, alias?: (spec: string) => string | null) {
	for (const p of walk(srcRoot)) {
		const rel = relative(srcRoot, p).replaceAll('\\', '/');
		if (rel.endsWith('.d.ts') || rel.endsWith('.map')) continue;
		const isSvelte = rel.endsWith('.svelte');
		const isRuneMod = /\.svelte\.[jt]s$/.test(rel);
		const isTs = rel.endsWith('.ts');
		if (!isSvelte && !isRuneMod && !isTs && !rel.endsWith('.js')) continue;
		const src = await Bun.file(p).text();
		let code: string;
		if (isSvelte)
			code = compile(src, { generate: 'client', filename: p, dev: false, css: 'injected' }).js.code;
		else if (isRuneMod)
			// .svelte.ts: strip types first, then compile runes
			code = compileModule(rel.endsWith('.ts') ? tsx.transformSync(src) : src, {
				generate: 'client',
				filename: p,
				dev: false,
			}).js.code;
		else if (isTs) code = tsx.transformSync(src);
		else code = src;

		const outName = rel.replace(/\.svelte(\.[jt]s)?$/, '.js').replace(/\.ts$/, '.js');
		const outDir = join(outRoot, outName.split('/').slice(0, -1).join('/') || '.');
		// spec rewrites — aliases first (targets may still end in .svelte, the
		// generic suffix pass normalizes them), then .svelte→.js, then svelte/*
		code = code.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
		if (alias)
			code = code.replace(/(from\s+['"])([^'"]+)(['"])/g, (m, q1, spec, q2) => {
				const t = alias(spec);
				return t ? `${q1}${relative(outDir, join(outRoot, t)).replaceAll('\\', '/')}${q2}` : m;
			});
		code = code.replace(/(from\s+['"][^'"]+)\.svelte(?:\.[jt]s)?(['"])/g, '$1.js$2');
		const genDepth = relative('src/gen', join(outRoot, outName)).split('/').length - 1;
		const svelteShim = '../'.repeat(genDepth + 1) + 'svelte-client.js'; // shim lives in src/, one up from gen/
		const nm = '../'.repeat(genDepth + 2) + 'node_modules/';
		code = code.replace(/from\s+(['"])(svelte(?:\/[\w/-]*)?)\1/g, (m, q, spec) => {
			if (spec === 'svelte') return `from ${q}${svelteShim}${q}`;
			const target = svelteSubpath(spec);
			return target ? `from ${q}${nm}${target}${q}` : m;
		});
		mkdirSync(outDir, { recursive: true });
		await Bun.write(join(outRoot, outName), code);
	}
	console.log(`vendored ${srcRoot} → ${outRoot}`);
}

// $lib/* → gen/shadcn targets (mirrors the registry's $lib layout onto our tree)
const shadcnAlias = (spec: string): string | null => {
	if (spec === 'bits-ui') return 'lib/bits-stub.js';
	if (spec === '$lib/utils.js') return 'lib/utils.js';
	let m = spec.match(/^\$lib\/registry\/ui\/(.+)/);
	if (m) return m[1];
	m = spec.match(/^\$lib\/registry\/hooks\/(.+)/);
	if (m) return 'lib/hooks/' + m[1];
	m = spec.match(/^\$lib\/components\/icon-placeholder\/(.+)/);
	if (m) return 'lib/' + m[1];
	m = spec.match(/^\$lib\/(.+)/);
	if (m) return 'lib/' + m[1];
	return null;
};

await vendorDir('src/shadcn', 'src/gen/shadcn', shadcnAlias);
await vendorDir('node_modules/svelte-streamdown/dist', 'src/gen/vendor/svelte-streamdown');
// dashboard code may reach back into src/ (native.ts telemetry helpers)
await vendorDir('src/dashboard', 'src/gen/dashboard', (spec) =>
	spec === '../native' || spec === '../native.js' ? '../../native.ts' : null,
);
// native kit — svelai-token components; '../native(.js)' reaches back to src/native.ts
await vendorDir('src/nkit', 'src/gen/nkit', (spec) =>
	spec === '../native' || spec === '../native.js' ? '../../native.ts' : null,
);

// ── generate the route manifest (gen/routes/manifest.js) ────────────────────
const parentDir = (k) => k.split('/').slice(0, -1).join('/');
const ancestors = (k) => {
	// root→leaf dir keys: '' → [''], 'a/b' → ['', 'a', 'a/b']
	const out = [''];
	const parts = k ? k.split('/') : [];
	for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
	return out;
};
const findErrorKey = (from) => {
	// nearest dir with +error.svelte, walking up to root
	for (let k = from; ; k = parentDir(k)) {
		if (routeDirs.get(k)?.has('+error.svelte')) return k;
		if (k === '') return null;
	}
};
const compiledPath = (key, file) => './' + (key ? `${key}/` : '') + file.replace('.svelte', '.js');
const srcPath = (key, file) => '../../routes/' + (key ? `${key}/` : '') + file;

let n = 0;
const imports = [];
const impCache = new Map();
const imp = (spec, def = true) => {
	const cacheKey = `${def}:${spec}`;
	if (impCache.has(cacheKey)) return impCache.get(cacheKey);
	const name = `M${n++}`;
	impCache.set(cacheKey, name);
	imports.push(def ? `import ${name} from '${spec}';` : `import * as ${name} from '${spec}';`);
	return name;
};
/** emit {component?, load?, serverLoad?, actions?, boundaryError?} for one level */
const levelExpr = (dir, isPage, files) => {
	const compFile = isPage ? '+page.svelte' : '+layout.svelte';
	const parts = [];
	if (files.has(compFile)) parts.push(`component: ${imp(compiledPath(dir, compFile))}`);
	const loadFile = isPage ? '+page.ts' : '+layout.ts';
	const serverFile = isPage ? '+page.server.ts' : '+layout.server.ts';
	if (files.has(loadFile)) parts.push(`load: ${imp(srcPath(dir, loadFile), false)}.load`);
	if (files.has(serverFile)) {
		const mod = imp(srcPath(dir, serverFile), false);
		parts.push(`serverLoad: ${mod}.load`);
		if (isPage) parts.push(`actions: ${mod}.actions`);
	}
	const errKey = findErrorKey(isPage ? dir : parentDir(dir));
	if (errKey !== null) parts.push(`boundaryError: ${imp(compiledPath(errKey, '+error.svelte'))}`);
	return `{ ${parts.join(', ')} }`;
};

// (group) dirs contribute layouts/errors but no URL segment
const stripGroups = (k) => k.split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/');
const routeId = (k) => '/' + stripGroups(k);

const pageKeys = [...routeDirs.keys()]
	.filter((k) => routeDirs.get(k).has('+page.svelte'))
	// specificity: fewer dynamic segments, fewer optionals, more depth wins
	.sort((a, b) => {
		const dyn = (s) => (s.match(/\[\[\.\.\.|\[\[|\[\.\.\.|\[/g) ?? []).length;
		const opt = (s) => (s.match(/\[\[/g) ?? []).length;
		return dyn(a) - dyn(b) || opt(a) - opt(b) || stripGroups(b).split('/').length - stripGroups(a).split('/').length;
	});

// dedupe layout levels by dir — the same level object across routes lets the
// router reuse kept layouts' data on navigation (kit semantics)
const layoutIndex = new Map();
const layoutExprs = [];
const layoutLevel = (dir) => {
	if (!layoutIndex.has(dir)) {
		layoutIndex.set(dir, layoutExprs.length);
		layoutExprs.push(levelExpr(dir, false, routeDirs.get(dir)));
	}
	return layoutIndex.get(dir);
};

const routeEntries = pageKeys.map((key) => {
	const layoutIdxs = ancestors(key)
		.filter((d) => routeDirs.get(d)?.has('+layout.svelte') || routeDirs.get(d)?.has('+layout.ts') || routeDirs.get(d)?.has('+layout.server.ts'))
		.map((d) => layoutLevel(d));
	const errKey = findErrorKey(key);
	const pageExpr = levelExpr(key, true, routeDirs.get(key));
	const errExpr = errKey !== null ? `, error: ${imp(compiledPath(errKey, '+error.svelte'))}` : '';
	return `  { id: '${routeId(key)}', layouts: [${layoutIdxs.join(', ')}], page: ${pageExpr}${errExpr} }`;
});

// +server.ts endpoints — any dir (with or without a page)
const endpointEntries = [...routeDirs.keys()]
	.filter((k) => routeDirs.get(k).has('+server.ts'))
	.map((k) => `  '${routeId(k)}': ${imp(srcPath(k, '+server.ts'), false)}`);

// src/params/*.ts — [param=matcher] constraint modules (kit convention)
const paramFiles = readdirSync('src/params').filter((f) => /\.(ts|js)$/.test(f));
const matcherEntries = paramFiles.map(
	(f) => `  '${f.replace(/\.(ts|js)$/, '')}': ${imp(`../../params/${f}`, false)}.match`,
);

const manifest = `// generated by build.ts — do not edit\n${imports.join('\n')}\n\nconst __layouts = [\n  ${layoutExprs.join(',\n  ')}\n];\n\nexport const routes = [\n${routeEntries.join(',\n')}\n];\n\nfor (const r of routes) r.layouts = r.layouts.map((i) => __layouts[i]);\n\nexport const endpoints = {\n${endpointEntries.join(',\n')}\n};\n\nexport const matchers = {\n${matcherEntries.join(',\n')}\n};\n`;
await Bun.write('src/gen/routes/manifest.js', manifest);
console.log(`manifest: ${pageKeys.length} routes, ${endpointEntries.length} endpoints, ${matcherEntries.length} matchers → src/gen/routes/manifest.js`);
