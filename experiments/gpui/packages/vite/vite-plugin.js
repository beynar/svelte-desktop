/**
 * svelteNative() — Vite plugin that compiles a SvelteKit-shaped src/routes
 * app for the native renderer (gdom → gpuix op stream). This is the
 * productized form of packages/svelte/build.ts:
 *
 *   build.ts step                      → vite-plugin equivalent
 *   compile(..., generate:'client')    → transform() on .svelte ids
 *   compileModule(...)                 → transform() on .svelte.js/.svelte.ts
 *   'svelte' → svelte-client.js shim   → resolve.alias svelte→src/index-client.js
 *   'svelte/*' → client subpaths       → resolveId → src/<sub>/index-client.js
 *   strip '.css' imports               → strip + harvest through native-css
 *   relative '.svelte→.js' rewrites    → not needed (vite serves sources);
 *                                        inverse .js→.svelte.js fallback in resolveId
 *   gen/routes/manifest.js             → virtual:svelte-native/manifest
 *   css:'injected'                     → css:'external' → virtual:svelte-native-style?<id>
 *
 * No @sveltejs/kit internals: the kit-shaped runtime in
 * packages/svelte/kit is the client, reached through $app/* aliases.
 */
import { compile, compileModule } from 'svelte/compiler';
import { DevEnvironment } from 'vite';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve as resolvePath, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	PKG_DIR,
	REPO_ROOT,
	GPUIX_PKG,
	SVELTE_PKG,
	GPUIX_NATIVE,
	GPUIX_NATIVE_EXTERNAL,
	NATIVE_CSS_PARSE,
	NATIVE_CSS_REGISTER,
	resolveSvelteDir,
	svelteClientSubpath,
	toImportSpecifier,
} from './paths.js';
import { generateManifest, isRouteSurfaceFile } from './manifest.js';
// emit.js ↔ vite-plugin.js is a declared cycle (buildNativeApp falls back to
// an inline svelteNative); all uses here are deferred to hook time — safe.
import { emitEntry } from './emit.js';
import { startNativeHost } from './dev-session.js';

const MANIFEST_ID = 'virtual:svelte-native/manifest';
const STYLE_PREFIX = 'virtual:svelte-native-style?';
const RESOLVED_MANIFEST = '\0' + MANIFEST_ID;
/** Resolved style ids get a `.sheet` trailer: without it the encoded source
 *  path sits at the id tail (`…?%2F…%2Fchrome.css`) and vite's css pipeline
 *  claims the module — css-post then minifies our registerSheet JS as css. */
const STYLE_SUFFIX = '.sheet';
const RESOLVED_STYLE_PREFIX = '\0' + STYLE_PREFIX;
/** appended to every module this plugin compiles — makes a second
 *  svelteNative() instance in the plugin list (e.g. a CLI adding the plugin
 *  on top of a user vite.config that already has it) a no-op instead of a
 *  double compile. */
const MARKER = '/* svelte-native:compiled */';
/** build.ts's css-import strip regex — bare side-effect imports only;
 *  `import x from './a.css'` / './a.css?inline' deliberately don't match. */
const CSS_IMPORT = /import\s+['"]([^'"]+\.css)['"];?/g;

const shim = (name) => join(PKG_DIR, 'runtime', name);

/** ws endpoint the Bun host connects to (configureServer binds it). */
const HMR_WS_PATH = '/__svelte_native_hmr';
/** random token generated per boot — the ws upgrade requires it as a
 *  query param so arbitrary local processes can't read source via
 *  vite:invoke/fetchModule (skipFsCheck bypasses fs.allow) */
const WS_TOKEN = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
/** node builtins the 'native' environment externalizes for the Bun runner —
 *  bun:* schemes are ours to declare (server consumer covers node:* anyway,
 *  but resolve.builtins replaces the default so we list both) */
const NATIVE_BUILTINS = [
	...builtinModules,
	...builtinModules.map((m) => `node:${m}`),
	/^bun:/,
	/^@gpuix\/native/,
];

/**
 * HotChannel bridging the 'native' environment to a dedicated websocket —
 * the protocol is symmetric HotPayload JSON: send() broadcasts update /
 * full-reload / prune / error payloads, incoming 'custom' messages dispatch
 * to on() listeners (normalizeHotChannel adds the vite:invoke RPC that the
 * runner's transport uses for fetchModule + getBuiltins).
 */
function createWsHotChannel() {
	const listeners = new Map(); // event → Set<fn>
	const sockets = new Set();
	return {
		skipFsCheck: true, // same machine — the entry imports abs paths under packages/*.
		                    // The ws token (WS_TOKEN) gates who can reach fetchModule.
		_attach(socket) {
			sockets.add(socket);
			const client = {
				send: (p) => {
					try {
						socket.send(JSON.stringify(p));
					} catch {}
				},
			};
			socket.on('message', (raw) => {
				let msg;
				try {
					msg = JSON.parse(raw);
				} catch {
					return;
				}
				if (msg?.type === 'custom') {
					for (const fn of listeners.get(msg.event) ?? []) {
						try {
							fn(msg.data, client);
						} catch (e) {
							console.error('[svelte-native] hot listener error:', e);
						}
					}
				}
			});
			socket.on('close', () => sockets.delete(socket));
			for (const fn of listeners.get('connection') ?? []) fn();
		},
		send(payload) {
			const s = JSON.stringify(payload);
			for (const sk of sockets) {
				try {
					sk.send(s);
				} catch {}
			}
		},
		on(event, fn) {
			let set = listeners.get(event);
			if (!set) listeners.set(event, (set = new Set()));
			set.add(fn);
		},
		off(event, fn) {
			listeners.get(event)?.delete(fn);
		},
		listen() {},
		close() {
			for (const sk of sockets) {
				try {
					sk.close();
				} catch {}
			}
			sockets.clear();
			listeners.clear(); // dead env's vite:invoke handler must not linger
		},
	};
}

/** Entry-emission opts accepted on svelteNative() — forwarded to emitEntry
 *  for both the dev session window and `vite build`. */
const ENTRY_KEYS = ['title', 'width', 'height', 'startPath', 'backend', 'rendererClass', 'headless', 'hooks', 'titlebarTransparent', 'appOwnsTitlebarDrag', 'trafficLightX', 'trafficLightY'];

export function svelteNative(opts = {}) {
	const routesDirName = opts.routesDir ?? 'src/routes';
	const paramsDirName = opts.paramsDir ?? 'src/params';
	const outDirName = opts.outDir ?? '.svelte-native';
	/** svelte/compiler options — generate/css/filename/dev stay plugin-owned */
	const compilerOptions = opts.compilerOptions ?? {};
	const entryOpts = Object.fromEntries(ENTRY_KEYS.filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]));

	let root = process.cwd();
	let command = 'build';
	/** compile({dev,hmr}) — `vite dev`, a dev-session build (SVELTE_NATIVE_DEV),
	 *  or an explicit opts.dev boolean */
	let devMode = false;
	let svelteDir = null;
	let routesAbs = '';
	let paramsAbs = '';
	/** source-path → {rules, warnings} harvested css, consumed by the style virtual module */
	const sheets = new Map();
	/** the 'native' environment's hot channel — sockets attach in
	 *  configureServer; the env is created from it in config() below */
	const wsChannel = createWsHotChannel();
	/** lazy-loaded native-css parser (parallel-agent module — may not exist yet) */
	let parseMod = null;

	async function parseCss(css) {
		if (!parseMod) {
			// retried on every call until it lands — the parser is built by a
			// parallel agent and may appear mid-session; failures are cheap
			try {
				parseMod = await import(pathToFileURL(NATIVE_CSS_PARSE).href);
			} catch {
				parseMod = null;
			}
		}
		if (parseMod?.parseStylesheet) {
			try {
				const r = parseMod.parseStylesheet(css);
				return {
					rules: r.rules ?? [],
					warnings: r.warnings ?? [],
					keyframes: r.keyframes ?? [],
					animations: r.animations ?? [],
				};
			} catch (e) {
				return { rules: [], warnings: [`parseStylesheet threw: ${e?.message ?? e}`] };
			}
		}
		// fallback: no parser → empty sheet. Rules pass VERBATIM to the Rust
		// stylesheet engine (stylesheet.register op), so a raw-css pseudo-rule
		// would poison the batch — an empty list + a warning is the safe shape.
		return {
			rules: [],
			warnings: [`${NATIVE_CSS_PARSE} not found — <style> rules dropped`],
		};
	}

	/** JSON literal for a parsed-rules payload (Map/Set-tolerant). */
	const toLiteral = (v) =>
		JSON.stringify(v, (_k, x) => (x instanceof Map ? { __map: [...x] } : x instanceof Set ? [...x] : x));

	/**
	 * build.ts's `.css` import strip — but instead of dropping the styles we
	 * resolve+read+harvest the file into the importer's sheet, so the css
	 * still lands in the native stylesheet registry.
	 */
	function stripCssImports(code, importerPath) {
		return code.replace(CSS_IMPORT, (m, spec) => {
			const base = spec.startsWith('.') ? resolvePath(dirname(importerPath), spec) : null;
			const file = base && existsSync(base) ? base : null;
			if (!file) {
				if (base) console.warn(`[svelte-native] css import not found: ${spec} (from ${importerPath})`);
				return ''; // unresolvable → drop, like build.ts
			}
			try {
				const css = readFileSync(file, 'utf8');
				const sheet = sheets.get(file) ?? null;
				if (!sheet) {
					// defer actual parsing to load() of the virtual module — stash raw
					sheets.set(file, { pendingCss: css });
				}
				return `import ${JSON.stringify(STYLE_PREFIX + encodeURIComponent(file))};`;
			} catch {
				return '';
			}
		});
	}

	const stripQuery = (id) => id.split('?')[0];
	const importerFs = (importer) => {
		if (!importer) return null;
		const i = importer.replace(/^\0/, '').split('?')[0];
		if (i.startsWith('/@fs/')) return i.slice(4);
		return i.startsWith('/') || /^[A-Za-z]:/.test(i) ? i : null;
	};

	return {
		name: 'svelte-native',
		enforce: 'pre',

		config(config, env) {
			command = env.command;
			devMode = command === 'serve' || process.env.SVELTE_NATIVE_DEV === '1';
			const candidateRoot = config.root ? resolvePath(config.root) : process.cwd();
			// Runtime svelte resolves through the framework's own copy —
			// svelte-client.js re-exports ./node_modules/svelte/src/index-client.js,
			// so packages/svelte's install is the canonical runtime instance.
			// resolveSvelteDir() realpaths to the .bun store; the relative-import
			// shortcut below realpaths its returns to match — every svelte
			// internal module must share ONE module id or component context
			// splits in two (getContext reads a permanently-null instance →
			// lifecycle_outside_component).
			svelteDir =
				resolveSvelteDir(SVELTE_PKG) ??
				resolveSvelteDir(candidateRoot) ??
				resolveSvelteDir(PKG_DIR);
			const clientEntry = svelteDir
				? join(svelteDir, 'src/index-client.js')
				: 'svelte/src/index-client.js';
			const internalRoot = svelteDir ? join(svelteDir, 'src/internal') : 'svelte/src/internal';
			const out = {
				resolve: {
					alias: [
						// $app/* — kit-shaped runtime shims (no @sveltejs/kit internals)
						{ find: /^\$app\/state$/, replacement: shim('state.js') },
						{ find: /^\$app\/navigation$/, replacement: shim('navigation.js') },
						{ find: /^\$app\/environment$/, replacement: shim('environment.js') },
						{ find: /^\$app\/paths$/, replacement: shim('paths.js') },
						{ find: /^\$app\/forms$/, replacement: shim('forms.js') },
						{ find: /^\$app\/server$/, replacement: shim('server.js') },
						// @sveltejs/kit + poc's #kit → the in-process kit runtime
						{ find: /^@sveltejs\/kit$/, replacement: shim('kit.js') },
						{ find: /^#kit$/, replacement: shim('kit.js') },
						// '@gpuix/native' → the deployed copy — apps have no copy
						// of their own and a registry install would not be our
						// build. Build-only: in dev the specifier must stay bare
						// (fetchModule externalizes bare imports via node
						// resolution; an abs path would inline the CJS loader).
						...(command !== 'serve'
							? [{ find: /^@gpuix\/native$/, replacement: GPUIX_NATIVE }]
							: []),
						// 'svelte' → the client entry build.ts's svelte-client.js targets
						// (Bun/native resolves the exports map to the server entry)
						{ find: /^svelte$/, replacement: clientEntry },
						{ find: /^svelte\/internal\/(.*)$/, replacement: `${internalRoot}/$1` },
					],
				},
				// the native stack lives outside the app root — let the dev server
				// read packages/gpuix + packages/svelte sources via /@fs/
				server: { fs: { allow: [candidateRoot, REPO_ROOT] } },
				optimizeDeps: { exclude: ['svelte'] },
				// the 'native' environment — the Bun host's ModuleRunner fetches
				// transformed modules + receives hmr payloads through its hot
				// channel (our ws bridge). server consumer: externals (bun:*,
				// @gpuix/native, node:*) stay real imports in the child.
				environments: {
					native: {
						consumer: 'server',
						resolve: {
							builtins: NATIVE_BUILTINS,
							// external by specifier — the abs-path pin in
							// resolveId would skip this check (it's bare-only)
							// and inline the CJS napi loader into the runner
							external: ['@gpuix/native'],
						},
						dev: {
							createEnvironment: (name, config, context) =>
								new DevEnvironment(name, config, {
									...context,
									hot: true,
									transport: wsChannel,
								}),
						},
					},
				},
			};
			// `vite build` → the native bundle, same as buildNativeApp(). The
			// emitted entry lives inside outDir, so emptyOutDir must stay off —
			// vite would wipe the input before bundling it.
			if (command === 'build' && opts.emitBundle !== false) {
				// buildNativeApp emits its own entry (headless/rendererClass
				// opts) then runs vite build — a config-hook emit here would
				// stomp that entry mid-build. The env flag marks it written.
				const emitted = process.env.SVELTE_NATIVE_ENTRY_WRITTEN === '1';
				const { entryPath, outDirAbs } = emitted
					? {
							entryPath: join(candidateRoot, outDirName, 'app.js'),
							outDirAbs: join(candidateRoot, outDirName),
						}
					: emitEntry({ root: candidateRoot, outDir: outDirName, ...entryOpts });
				out.build = {
					ssr: entryPath,
					outDir: outDirAbs,
					emptyOutDir: false,
					minify: false,
					target: 'esnext',
					rollupOptions: {
						external: [/^bun:/, GPUIX_NATIVE_EXTERNAL],
						output: { format: 'esm', entryFileNames: 'app.js' },
					},
				};
				out.ssr = { noExternal: ['svelte', 'esm-env', 'clsx', 'devalue'] };
			}
			return out;
		},

		configResolved(config) {
			root = config.root;
			routesAbs = isAbsolute(routesDirName) ? routesDirName : join(root, routesDirName);
			paramsAbs = isAbsolute(paramsDirName) ? paramsDirName : join(root, paramsDirName);
		},

		buildStart() {
			// vite build --watch / rollup.watch: route add/remove must trigger a
			// rebuild. chokidar watches dirs recursively, so this covers future
			// +page.svelte files that aren't in the module graph yet.
			for (const d of [routesAbs, paramsAbs]) {
				try {
					if (existsSync(d) && statSync(d).isDirectory()) this.addWatchFile(d);
				} catch {}
			}
		},

		configureServer(server) {
			// add/unlink change the route set; 'change' matters too — manifest
			// emission is export-aware (load/actions gated on hasExport), so an
			// edit that adds an export reshapes the manifest
			const invalidate = (file) => {
				if (!isRouteSurfaceFile(file, routesAbs, paramsAbs)) return;
				// the manifest lives in the 'native' env's graph — the top-level
				// server.moduleGraph is the *client* env's (wrong graph, no-op)
				const env = server.environments?.native;
				const mod = env?.moduleGraph?.getModuleById?.(RESOLVED_MANIFEST);
				if (mod) env.moduleGraph.invalidateModule(mod);
				env?.hot?.send?.({ type: 'full-reload', path: '*' });
			};
			server.watcher.on('add', invalidate);
			server.watcher.on('unlink', invalidate);
			// 'change' deliberately omitted — a .svelte edit is an HMR update
			// (self-accepted by $.hmr), not a manifest change. Sending
			// full-reload here would destroy all component state on every save.

			// .css files are harvested into the importer's sheet — they're in
			// no module graph, so a .css edit sends no update. Invalidate the
			// style virtual module for every importer that harvested it.
			server.watcher.on('change', (file) => {
				if (!file.endsWith('.css') || !sheets.has(file)) return;
				const env = server.environments?.native;
				const styleId = RESOLVED_STYLE_PREFIX + encodeURIComponent(file) + STYLE_SUFFIX;
				const mod = env?.moduleGraph?.getModuleById?.(styleId);
				if (mod) env.moduleGraph.invalidateModule(mod);
				env?.hot?.send?.({ type: 'full-reload', path: '*' });
			});

			// ── native dev host: `vite dev` owns the window ─────────────────
			// no rebuild+restart: the Bun child runs a ModuleRunner fed by the
			// 'native' environment — .svelte edits self-accept (state kept),
			// dead ends trigger an in-process full-reload that remounts on the
			// persistent renderer (emit.js's __svelteNativeHost). dev:false
			// opts out (CI, pure-build configs, tests).
			if (opts.dev === false || process.env.SVELTE_NATIVE_NO_DEV === '1') return;
			if (!server.httpServer) {
				server.config.logger.warn('[svelte-native] dev needs an httpServer for the hmr transport — skipping window');
				return;
			}

			// the runtime lives outside the app root — its modules are in the
			// 'native' env graph, so watching them feeds hmr directly
			server.watcher.add([join(GPUIX_PKG, 'src'), SVELTE_PKG]);

			const boot = () => {
				// ws endpoint the Bun host connects to — carries HotPayload JSON
				const wss = new WebSocketServer({ noServer: true });
				server.httpServer.on('upgrade', (req, socket, head) => {
					// req.url carries the query string — parse for pathname + token
					const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
					if (url.pathname !== HMR_WS_PATH) return;
					if (url.searchParams.get('token') !== WS_TOKEN) {
						socket.destroy();
						return;
					}
					wss.handleUpgrade(req, socket, head, (ws) => wsChannel._attach(ws));
				});

				const { entryPath, outDirAbs } = emitEntry({
					root,
					outDir: outDirName,
					...entryOpts,
					...(typeof opts.dev === 'object' ? opts.dev : {}),
				});
				// what the child connects to + imports (re-read on reconnect).
				// resolvedUrls isn't populated yet at 'listening' — derive
				// from httpServer.address() which is available synchronously
				const addr = server.httpServer.address();
				const local = addr && typeof addr === 'object'
					? `http://${addr.family === 'IPv6' ? `[${addr.address}]` : addr.address}:${addr.port}/`
					: `http://localhost:${server.httpServer.address()?.port ?? 5173}/`;
				writeFileSync(
					join(outDirAbs, 'dev.json'),
					JSON.stringify({
						wsUrl: local.replace(/^http/, 'ws').replace(/\/$/, '') + HMR_WS_PATH + `?token=${WS_TOKEN}`,
						entry: `/${outDirName}/app.js`,
					}),
				);
				const session = startNativeHost({
					root,
					env: {
						SVELTE_NATIVE_ROOT: root,
						SVELTE_NATIVE_DEVJSON: join(outDirAbs, 'dev.json'),
					},
					log: (m) => server.config.logger.info(m),
				});

				let disposed = false;
				const shutdown = () => {
					if (disposed) return;
					disposed = true;
					session.dispose();
					wsChannel.close();
					wss.close();
				};
				server.httpServer?.once('close', shutdown);
				// one-shot listeners — registered once per plugin instance, not
				// per boot() call (vite restart re-runs configureServer but the
				// process-level listeners must not accumulate)
				process.once('exit', shutdown);
				process.once('SIGINT', () => { shutdown(); process.kill(process.pid, 'SIGINT'); });
				process.once('SIGTERM', shutdown);
			};
			server.httpServer.once('listening', boot);
		},

		resolveId(id, importer) {
			if (id === MANIFEST_ID) return RESOLVED_MANIFEST;
			if (id.startsWith(STYLE_PREFIX)) return RESOLVED_STYLE_PREFIX + id.slice(STYLE_PREFIX.length) + STYLE_SUFFIX;

			// '@gpuix/native' → the deployed copy (see GPUIX_NATIVE) — the app
			// has no copy of its own, and a registry install would not be our
			// build. external:true keeps `import '<abs>'` in the bundle —
			// inlining the napi loader would break its relative .node loading.
			// In dev the specifier must stay BARE: fetchModule externalizes
			// only bare imports (its abs-path branch inlines → CJS require dies).
			if (id === '@gpuix/native') {
				if (command === 'serve') return { id: '@gpuix/native', external: true };
				return { id: GPUIX_NATIVE, external: true };
			}

			// 'svelte/<sub>' → client entry inside the svelte package when one
			// exists (build.ts's svelteSubpath — internal/* goes through the alias)
			if (id.startsWith('svelte/') && !id.startsWith('svelte/internal/')) {
				const target = svelteClientSubpath(id, svelteDir);
				if (target) return target;
				return null;
			}

			// relative imports that name a .js the source tree doesn't have:
			// authored source is .svelte.js/.svelte.ts/.ts and build.ts renamed
			// outputs to .js — under vite we resolve the SOURCE instead
			// ('./runtime.js' → runtime.svelte.js, '../remote.js' → remote.svelte.js)
			const from = importerFs(importer);
			if (from && (id.startsWith('./') || id.startsWith('../'))) {
				const base = resolvePath(dirname(from), stripQuery(id));
				// gpuixReachback: src/nkit/ uses ../../gdom.ts designed for the
				// compiled gen/nkit/ location — rewrite to the package specifier
				if (!existsSync(base)) {
					const rb = id.match(/(?:^|\/)(gdom|native)(?:\.(?:ts|js))?$/);
					if (rb) return join(GPUIX_PKG, 'src', `${rb[1]}.ts`);
				}
				// realpathSync canonicalizes ids through symlinked node_modules
				// dirs — vite's own resolver realpaths, so returning the literal
				// path would register a second instance of the same file (this
				// split svelte's component_context in two → getContext threw
				// lifecycle_outside_component inside a live component).
				if (existsSync(base)) return realpathSync(base);
				{
					const stem = base.replace(/\.[jt]s$/, '');
					const candidates = [
						`${stem}.svelte.js`,
						`${stem}.svelte.ts`,
						`${stem}.ts`,
						`${stem}.js`,
						`${base}.ts`,
						`${base}.js`,
						`${base}.svelte.js`,
						`${base}.svelte.ts`,
						`${base}/index.ts`,
						`${base}/index.js`,
						`${base}/index.svelte.js`,
					];
					for (const c of candidates) if (existsSync(c)) return realpathSync(c);
				}
			}
			return null;
		},

		async load(id) {
			if (id === RESOLVED_MANIFEST) {
				return generateManifest({ routesDir: routesAbs, paramsDir: paramsAbs, root });
			}
			if (id.startsWith(RESOLVED_STYLE_PREFIX)) {
				const srcPath = decodeURIComponent(
					id.slice(RESOLVED_STYLE_PREFIX.length, -STYLE_SUFFIX.length),
				);
				let sheet = sheets.get(srcPath);
				if (sheet?.pendingCss) {
					// .css-file import harvested in stripCssImports — parse lazily
					// here (transform is sync-only for the plain-js path)
					const parsed = await parseCss(sheet.pendingCss);
					sheet = { ...sheet, ...parsed };
					delete sheet.pendingCss;
					sheets.set(srcPath, sheet);
				}
				sheet ??= { rules: [], warnings: [`no harvested css for ${srcPath}`] };
				for (const w of sheet.warnings ?? []) this.warn(`[svelte-native style] ${srcPath}: ${w}`);
				return [
					`import { registerSheet } from ${JSON.stringify(toImportSpecifier(NATIVE_CSS_REGISTER, root))};`,
					`registerSheet(${JSON.stringify(srcPath)}, ${toLiteral(sheet.rules ?? [])}, ${toLiteral(sheet.keyframes ?? [])}, ${toLiteral(sheet.animations ?? [])});`,
				].join('\n');
			}
			return null;
		},

		async transform(code, id) {
			const fsPath = stripQuery(id);
			if (fsPath.startsWith('\0')) return null;
			if (code.includes(MARKER)) return null; // already compiled by a sibling instance

			if (fsPath.endsWith('.svelte')) {
				const out = compile(code, {
					// plugin-owned keys last: css:'external' is the native
					// stylesheet contract, generate:'client' the op-stream target
					...compilerOptions,
					generate: 'client',
					filename: fsPath,
					css: 'external',
					dev: devMode,
					hmr: devMode,
				});
				let js = out.js.code;
				const css = out.css?.code;
				if (css?.trim()) {
					const parsed = await parseCss(css);
					const prev = sheets.get(fsPath) ?? {};
					sheets.set(fsPath, { ...prev, ...parsed });
					js += `\nimport ${JSON.stringify(STYLE_PREFIX + encodeURIComponent(fsPath))};`;
					// the style virtual module's cached transform result holds the
					// OLD rules literal — invalidate it so the runner refetches
					const styleId = RESOLVED_STYLE_PREFIX + encodeURIComponent(fsPath) + STYLE_SUFFIX;
					const mod = this.environment?.moduleGraph?.getModuleById?.(styleId);
					if (mod) this.environment.moduleGraph.invalidateModule(mod);
				} else if (sheets.has(fsPath)) {
					sheets.delete(fsPath); // <style> removed — drop the stale sheet
				}
				js = stripCssImports(js, fsPath);
				return { code: `${js}\n${MARKER}`, map: out.js.map };
			}

			if (/\.svelte\.[jt]s$/.test(fsPath)) {
				let src = code;
				if (fsPath.endsWith('.ts')) {
					if (globalThis.Bun?.Transpiler) {
						src = new Bun.Transpiler({ loader: 'ts' }).transformSync(code);
					} else {
						const { transformWithEsbuild } = await import('vite');
						src = (await transformWithEsbuild(code, fsPath, { loader: 'ts' })).code;
					}
				}
				const out = compileModule(src, {
					...compilerOptions,
					generate: 'client',
					filename: fsPath,
					dev: devMode,
				});
				return { code: `${stripCssImports(out.js.code, fsPath)}\n${MARKER}`, map: out.js.map };
			}

			// plain js/ts modules: build.ts stripped `.css` imports from compiled
			// output — do the same for any source module, harvesting the sheet
			if (/\.[cm]?[jt]sx?$/.test(fsPath) && CSS_IMPORT.test(code)) {
				CSS_IMPORT.lastIndex = 0;
				return { code: stripCssImports(code, fsPath), map: null };
			}
			return null;
		},
	};
}

export default svelteNative;
export { MANIFEST_ID, STYLE_PREFIX };
