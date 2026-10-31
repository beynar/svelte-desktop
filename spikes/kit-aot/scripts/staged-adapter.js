// Wraps @sveltejs/adapter-bun@1.0.0-next.2 so the final executable can be built by hand.
//
// adapter-bun's `buildOptions.compile` mode does two things:
//   1. "embed" mode: it generates a virtual `routes.js` that imports every client
//      asset / prerendered page as `import asset_N from "/abs/path" with { type: 'file' }`,
//      so `bun build --compile` embeds them into the executable ($bunfs) and Bun.serve's
//      static `routes` serve them straight from the binary.
//   2. It calls Bun.build({ compile: { outfile: 'server' }, files: <virtual files>,
//      plugins: [<resolver for SERVER/MANIFEST/ROUTES/SERVER_OPTIONS>] }).
//
// We keep (1) and replace (2): while the adapter runs, Bun.build is swapped for a
// function that materializes the adapter's virtual files and its bare-specifier plugin
// into a plain on-disk module graph under `stage/`. `stage/entry.js` is then a normal
// entrypoint for `bun build --compile` (stable or canary, any flags, no plugin needed).
//
// Set ADAPTER_COMPILE=1 to also let the adapter run its own Bun.build compile
// (reference output, written to <out>/server). ADAPTER_COMPILE_EXTRA='{"aot":true,"trim":{"locales":["en"]}}'
// merges extra keys into that compile object -- equivalent to passing them through
// adapter({ buildOptions: { compile: {...} } }); only the canary understands aot/trim.
import adapter from '@sveltejs/adapter-bun';
import fs from 'node:fs';
import path from 'node:path';

const SPECIFIERS = ['SERVER', 'MANIFEST', 'ROUTES', 'SERVER_OPTIONS'];

/** @param {{ out?: string, stage?: string }} opts */
export function stagedAdapter({ out = 'build-adapter', stage = 'stage' } = {}) {
	const inner = adapter({ out, buildOptions: { compile: true } });
	return {
		...inner,
		name: 'staged-adapter-bun',
		async adapt(builder) {
			const real_build = Bun.build;
			Bun.build = async (config) => {
				write_stage(config, path.resolve(stage));
				builder.log.minor(`Staged adapter-bun module graph to ${stage}/entry.js`);
				if (process.env.ADAPTER_COMPILE === '1') {
					const extra = JSON.parse(process.env.ADAPTER_COMPILE_EXTRA ?? '{}');
					return real_build({ ...config, compile: { ...config.compile, ...extra } });
				}
				return { success: true, outputs: [], logs: [] };
			};
			try {
				await inner.adapt(builder);
			} finally {
				Bun.build = real_build;
			}
		}
	};
}

/** @param {import('bun').BuildConfig} config @param {string} stage */
function write_stage(config, stage) {
	fs.rmSync(stage, { recursive: true, force: true });
	const adapter_dir = path.join(stage, 'adapter');
	fs.mkdirSync(adapter_dir, { recursive: true });

	// Resolve the adapter plugin's bare specifiers the same way the plugin does.
	/** @type {Record<string, string>} */
	const resolved = {};
	const fake_build = {
		onResolve({ filter }, cb) {
			for (const s of SPECIFIERS) {
				if (filter.test(s) && !resolved[s]) {
					const r = cb({ path: s, importer: '', resolveDir: '' });
					if (r?.path) resolved[s] = r.path;
				}
			}
		},
		onLoad() {}
	};
	for (const plugin of config.plugins ?? []) plugin.setup(fake_build);

	const files = /** @type {Record<string, string>} */ (config.files ?? {});
	const entry = /** @type {string} */ (config.entrypoints[0]);
	const src_dir = path.dirname(entry);

	// virtual file path -> staged file path
	/** @type {Map<string, string>} */
	const staged = new Map();
	const stage_name = (/** @type {string} */ abs) =>
		path.join(adapter_dir, abs.startsWith(src_dir) ? path.relative(src_dir, abs) : path.basename(abs));

	// adapter runtime sources + virtual files
	for (const name of fs.readdirSync(src_dir)) {
		const abs = path.join(src_dir, name);
		staged.set(abs, stage_name(abs));
	}
	for (const abs of Object.keys(files)) staged.set(abs, stage_name(abs));

	/** @type {Record<string, string>} specifier -> replacement relative to adapter_dir */
	const spec_map = {};
	for (const [spec, abs] of Object.entries(resolved)) {
		const target = staged.get(abs) ?? abs; // SERVER points at .svelte-kit/bun-tmp/server.js on disk
		let rel = path.relative(adapter_dir, target);
		if (!rel.startsWith('.')) rel = `./${rel}`;
		spec_map[spec] = rel;
	}

	for (const [abs, dest] of staged) {
		let source = files[abs] ?? (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
		if (source == null) continue;
		source = source.replace(
			/(from\s*|import\s*\(?\s*)(['"])(SERVER|MANIFEST|ROUTES|SERVER_OPTIONS)\2/g,
			(_, pre, q, spec) => `${pre}${q}${spec_map[spec]}${q}`
		);
		fs.writeFileSync(dest, source);
	}

	const entry_rel = path.relative(stage, staged.get(entry));
	fs.writeFileSync(path.join(stage, 'entry.js'), `import './${entry_rel}';\n`);

	const { plugins, files: _f, ...rest } = config;
	fs.writeFileSync(
		path.join(stage, 'adapter-build-config.json'),
		JSON.stringify({ ...rest, plugins: plugins?.map((p) => p.name), resolved, spec_map }, null, 2)
	);
}
