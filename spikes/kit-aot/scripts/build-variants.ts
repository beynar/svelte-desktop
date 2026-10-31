// Builds every executable variant from the SAME entry and records build time / size / errors.
//
//   bun scripts/build-variants.ts            # all variants
//   bun scripts/build-variants.ts kit-f-aot  # only matching names
//
// Prereq: `bun --bun x vite build` has written stage/entry.js (see scripts/staged-adapter.js).
import { mkdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
// BUN_STABLE=none skips the stable variants (e.g. inside a Linux container with only the canary)
const STABLE = process.env.BUN_STABLE ?? Bun.which('bun')!;
const CANARY = process.env.BUN_CANARY ?? '/tmp/bun-canary/bun-darwin-aarch64/bun';
const TAG = process.env.KIT_AOT_TAG ? `-${process.env.KIT_AOT_TAG}` : '';
const OUT = join(ROOT, `out${TAG}`);
const RESULTS = join(ROOT, 'results');
mkdirSync(OUT, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

type Variant = { name: string; bun: 'stable' | 'canary'; entry: 'kit' | 'hello'; flags: string[] };

const KIT = join(ROOT, 'stage/entry.js');
const HELLO = join(ROOT, 'scripts/hello.ts');

const matrix: [string, 'stable' | 'canary', string[]][] = [
	['a-stable', 'stable', []],
	['b-canary', 'canary', []],
	['c-bytecode', 'canary', ['--bytecode']],
	['c2-bytecode-esm', 'canary', ['--bytecode', '--format=esm']],
	['d-trim', 'canary', ['--trim']],
	['e-trim-en', 'canary', ['--trim', '--trim-locales=en']],
	['f-aot', 'canary', ['--aot']],
	['g-aot-trim-en', 'canary', ['--aot', '--trim', '--trim-locales=en']],
	['h-aot-trim-en-nosrc', 'canary', ['--aot', '--trim', '--trim-locales=en', '--no-compile-function-source']]
];

const variants: Variant[] = [
	...matrix.map(([n, bun, flags]) => ({ name: `kit-${n}`, bun, entry: 'kit' as const, flags })),
	...[
		['a-stable', 'stable', []],
		['b-canary', 'canary', []],
		['f-aot', 'canary', ['--aot']],
		['e-trim-en', 'canary', ['--trim', '--trim-locales=en']],
		['g-aot-trim-en', 'canary', ['--aot', '--trim', '--trim-locales=en']]
	].map(([n, bun, flags]) => ({
		name: `hello-${n}`,
		bun: bun as 'stable' | 'canary',
		entry: 'hello' as const,
		flags: flags as string[]
	}))
];

const filter = process.argv.slice(2);
const selected = (filter.length ? variants.filter((v) => filter.some((f) => v.name.includes(f))) : variants).filter(
	(v) => !(v.bun === 'stable' && STABLE === 'none')
);

const results: Record<string, unknown>[] = [];
for (const v of selected) {
	const outfile = join(OUT, v.name);
	if (existsSync(outfile)) rmSync(outfile);
	const cmd = [
		v.bun === 'stable' ? STABLE : CANARY,
		'build',
		'--compile',
		...v.flags,
		v.entry === 'kit' ? KIT : HELLO,
		'--outfile',
		outfile
	];
	const t0 = performance.now();
	const proc = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
	const ms = Math.round(performance.now() - t0);
	const log = proc.stdout.toString() + proc.stderr.toString();
	await Bun.write(join(RESULTS, `build${TAG}-${v.name}.log`), `$ ${cmd.join(' ')}\n\n${log}`);
	const ok = proc.exitCode === 0 && existsSync(outfile);
	const bytes = ok ? statSync(outfile).size : null;
	const warnings = (log.match(/^warn:/gm) ?? []).length;
	const errors = log.split('\n').filter((l) => /^error:|error: /.test(l)).slice(0, 5);
	const r = { ...v, cmd: cmd.join(' ').replaceAll(ROOT + '/', ''), ok, exitCode: proc.exitCode, ms, bytes, mb: bytes && +(bytes / 1e6).toFixed(2), warnings, errors };
	results.push(r);
	console.log(`${v.name.padEnd(26)} ${ok ? 'OK  ' : 'FAIL'} ${String(ms).padStart(6)} ms  ${bytes ? (bytes / 1e6).toFixed(2).padStart(7) + ' MB' : '-'}  warn=${warnings} ${errors.join(' | ')}`);
}

const file = join(RESULTS, `build${TAG}.json`);
const prev: Record<string, unknown>[] = existsSync(file) ? await Bun.file(file).json() : [];
const merged = [...prev.filter((p) => !results.some((r) => r.name === p.name)), ...results];
await Bun.write(file, JSON.stringify(merged, null, 2));
