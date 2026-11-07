/**
 * Route manifest generation — the algorithm lifted verbatim from
 * packages/svelte/build.ts (lines 13–45 route scan, 220–314 manifest emit) with one
 * adaptation: emitted import specifiers point at the *source* files (vite
 * resolves them and routes .svelte/.ts back through this plugin's transform)
 * instead of precompiled gen/*.js outputs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toImportSpecifier } from './paths.js';

/**
 * build.ts's ROUTE_FILES — the kit-shaped files a route dir may contain.
 * Extended with `.js` twins of the `.ts` slots (kit accepts both; a `.ts`
 * file wins when both exist in the same dir).
 */
const ROUTE_FILES = [
	'+page.svelte',
	'+page.ts',
	'+page.js',
	'+page.server.ts',
	'+page.server.js',
	'+layout.svelte',
	'+layout.ts',
	'+layout.js',
	'+layout.server.ts',
	'+layout.server.js',
	'+error.svelte',
	'+server.ts',
	'+server.js',
];
const ROUTE_FILE_SET = new Set(ROUTE_FILES);

function* walk(dir) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) yield* walk(p);
		else yield p;
	}
}

/**
 * Scan routesDir → Map<routeDirKey, Set<basename>> ('' = root). Identical to
 * build.ts's scan — the dir key is the path relative to routesDir.
 */
export function scanRoutes(routesDir) {
	const routeDirs = new Map();
	if (!existsSync(routesDir)) return routeDirs;
	for (const p of walk(routesDir)) {
		const file = p.split('/').pop();
		if (!ROUTE_FILE_SET.has(file)) continue;
		const dir = relative(routesDir, p.split('/').slice(0, -1).join('/') || '.');
		const key = dir === '.' ? '' : dir;
		if (!routeDirs.has(key)) routeDirs.set(key, new Set());
		routeDirs.get(key).add(file);
	}
	return routeDirs;
}

/** Does this path belong to the scanned route/params surface? (watcher filters) */
export function isRouteSurfaceFile(file, routesDir, paramsDir) {
	const base = file.split('/').pop();
	if (routesDir && file.startsWith(routesDir + '/')) return ROUTE_FILE_SET.has(base);
	if (paramsDir && file.startsWith(paramsDir + '/')) return /\.(ts|js)$/.test(base);
	return false;
}

/**
 * Emit manifest module code: `export const routes/endpoints/matchers`.
 * Same structure as gen/routes/manifest.js — `__layouts` dedupe by dir,
 * +error.svelte boundary lookup walking ancestors, (group) stripping,
 * dynamic-segment specificity sort, per-route `error`.
 *
 * opts: { routesDir, paramsDir, root } — absolute dirs; `root` only decides
 *        whether emitted specifiers are root-relative or /@fs/.
 */
export function generateManifest({ routesDir, paramsDir, root }) {
	const routeDirs = scanRoutes(routesDir);

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
	const fileAbs = (key, file) => join(routesDir, ...(key ? key.split('/') : []), file);
	const spec = (key, file) => toImportSpecifier(fileAbs(key, file), root);
	// pick the .ts twin when both exist (kit-style precedence)
	const pick = (files, ...names) => names.find((n) => files.has(n)) ?? null;

	// emitting `actions: mod.actions` unconditionally makes the bundler warn
	// "no matching export" on every +page.server that only defines load —
	// gate on a lexical export check instead (cheap: route files are small)
	const exportCache = new Map();
	const hasExport = (absFile, name) => {
		const k = `${absFile}:${name}`;
		if (exportCache.has(k)) return exportCache.get(k);
		let ok = false;
		try {
			const src = readFileSync(absFile, 'utf8');
			ok = new RegExp(
				`export\\s+(?:const|let|var|function|async\\s+function)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`,
			).test(src);
		} catch {}
		exportCache.set(k, ok);
		return ok;
	};

	let n = 0;
	const imports = [];
	const impCache = new Map();
	const imp = (specifier, def = true) => {
		const cacheKey = `${def}:${specifier}`;
		if (impCache.has(cacheKey)) return impCache.get(cacheKey);
		const name = `M${n++}`;
		impCache.set(cacheKey, name);
		imports.push(def ? `import ${name} from '${specifier}';` : `import * as ${name} from '${specifier}';`);
		return name;
	};
	/** emit {component?, load?, serverLoad?, actions?, boundaryError?} for one level */
	const levelExpr = (dir, isPage, files) => {
		const compFile = isPage ? '+page.svelte' : '+layout.svelte';
		const parts = [];
		if (files.has(compFile)) parts.push(`component: ${imp(spec(dir, compFile))}`);
		const loadFile = pick(files, isPage ? '+page.ts' : '+layout.ts', isPage ? '+page.js' : '+layout.js');
		const serverFile = pick(
			files,
			isPage ? '+page.server.ts' : '+layout.server.ts',
			isPage ? '+page.server.js' : '+layout.server.js',
		);
		if (loadFile && hasExport(fileAbs(dir, loadFile), 'load'))
			parts.push(`load: ${imp(spec(dir, loadFile), false)}.load`);
		if (serverFile) {
			const abs = fileAbs(dir, serverFile);
			const hasLoad = hasExport(abs, 'load');
			const hasActions = isPage && hasExport(abs, 'actions');
			if (hasLoad || hasActions) {
				const mod = imp(spec(dir, serverFile), false);
				if (hasLoad) parts.push(`serverLoad: ${mod}.load`);
				if (hasActions) parts.push(`actions: ${mod}.actions`);
			}
		}
		const errKey = findErrorKey(isPage ? dir : parentDir(dir));
		if (errKey !== null) parts.push(`boundaryError: ${imp(spec(errKey, '+error.svelte'))}`);
		return `{ ${parts.join(', ')} }`;
	};

	// (group) dirs contribute layouts/errors but no URL segment
	const stripGroups = (k) =>
		k
			.split('/')
			.filter((s) => !/^\(.*\)$/.test(s))
			.join('/');
	const routeId = (k) => '/' + stripGroups(k);

	const pageKeys = [...routeDirs.keys()]
		.filter((k) => routeDirs.get(k).has('+page.svelte'))
		// specificity: fewer dynamic segments, fewer optionals, more depth wins
		.sort((a, b) => {
			const dyn = (s) => (s.match(/\[\[\.\.\.|\[\[|\[\.\.\.|\[/g) ?? []).length;
			const opt = (s) => (s.match(/\[\[/g) ?? []).length;
			return (
				dyn(a) - dyn(b) || opt(a) - opt(b) || stripGroups(b).split('/').length - stripGroups(a).split('/').length
			);
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
			.filter(
				(d) =>
					routeDirs.get(d)?.has('+layout.svelte') ||
					routeDirs.get(d)?.has('+layout.ts') ||
					routeDirs.get(d)?.has('+layout.js') ||
					routeDirs.get(d)?.has('+layout.server.ts') ||
					routeDirs.get(d)?.has('+layout.server.js'),
			)
			.map((d) => layoutLevel(d));
		const errKey = findErrorKey(key);
		const pageExpr = levelExpr(key, true, routeDirs.get(key));
		const errExpr = errKey !== null ? `, error: ${imp(spec(errKey, '+error.svelte'))}` : '';
		return `  { id: '${routeId(key)}', layouts: [${layoutIdxs.join(', ')}], page: ${pageExpr}${errExpr} }`;
	});

	// +server.{ts,js} endpoints — any dir (with or without a page)
	const endpointEntries = [...routeDirs.keys()]
		.map((k) => {
			const f = pick(routeDirs.get(k), '+server.ts', '+server.js');
			return f ? `  '${routeId(k)}': ${imp(spec(k, f), false)}` : null;
		})
		.filter(Boolean);

	// src/params/*.{ts,js} — [param=matcher] constraint modules (kit convention)
	const paramFiles = existsSync(paramsDir)
		? readdirSync(paramsDir).filter((f) => /\.(ts|js)$/.test(f))
		: [];
	const matcherEntries = paramFiles.map(
		(f) => `  '${f.replace(/\.(ts|js)$/, '')}': ${imp(toImportSpecifier(join(paramsDir, f), root), false)}.match`,
	);

	return `// generated by svelte-native (build.ts manifest algorithm) — do not edit
${imports.join('\n')}

const __layouts = [
  ${layoutExprs.join(',\n  ')}
];

export const routes = [
${routeEntries.join(',\n')}
];

for (const r of routes) r.layouts = r.layouts.map((i) => __layouts[i]);

export const endpoints = {
${endpointEntries.join(',\n')}
};

export const matchers = {
${matcherEntries.join(',\n')}
};
`;
}
