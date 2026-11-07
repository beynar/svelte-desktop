// Probe (results: see RESULTS.md): does the canary's Bun.build() JS API take the AOT / trim options too?
// (If yes, adapter-bun's own `buildOptions.compile` object could carry them when `vite build` runs on the canary.)
//   /tmp/bun-canary/bun-darwin-aarch64/bun scripts/jsapi-probe.ts
import { join } from 'node:path';
import { statSync, existsSync, rmSync } from 'node:fs';
const ROOT = join(import.meta.dir, '..');
const tries: [string, Record<string, unknown>][] = [
	['jsapi-aot', { aot: true }],
	['jsapi-trim', { trim: true }],
	['jsapi-aot-trim-obj', { aot: true, trim: { locales: ['en'] } }]
];
for (const [name, extra] of tries) {
	const outfile = join(ROOT, 'out', name);
	if (existsSync(outfile)) rmSync(outfile);
	const r = await Bun.build({
		entrypoints: [join(ROOT, 'stage/entry.js')],
		target: 'bun',
		compile: { outfile, ...extra } as any,
		throw: false
	});
	const size = existsSync(outfile) ? statSync(outfile).size : null;
	console.log(name, JSON.stringify(extra), 'success=' + r.success, size ? (size / 1e6).toFixed(2) + ' MB' : 'no file', r.success ? '' : r.logs.map((l: any) => l.message).join(' | ').slice(0, 300));
}
