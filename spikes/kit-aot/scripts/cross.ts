// Does the canary accept --aot / --trim when cross-compiling? (build only; binaries are not run)
//   bun scripts/cross.ts [hello|kit]
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CANARY = process.env.BUN_CANARY ?? '/tmp/bun-canary/bun-darwin-aarch64/bun';
const which = process.argv[2] ?? 'hello';
const entry = which === 'kit' ? join(ROOT, 'stage/entry.js') : join(ROOT, 'scripts/hello.ts');
const OUT = join(ROOT, 'out-cross');
mkdirSync(OUT, { recursive: true });

// Without --compile-executable-path, cross-compiling downloads the *stable* runtime of the same
// version (bun-<target>-v1.4.4), which has no trim table. Point these env vars at the matching
// canary runtime (github.com/oven-sh/bun/releases/tag/canary) to test --trim across targets.
const canary_runtime: Record<string, string | undefined> = {
	'bun-linux-x64': process.env.CANARY_LINUX_X64,
	'bun-windows-x64': process.env.CANARY_WINDOWS_X64
};
const targets = ['bun-linux-x64', 'bun-linux-arm64', 'bun-windows-x64', 'bun-darwin-x64'];
for (const [t, exe] of Object.entries(canary_runtime)) if (exe) targets.push(`${t}@${exe}`);
const flagsets = [[], ['--trim'], ['--trim', '--trim-locales=en'], ['--aot'], ['--aot', '--trim', '--trim-locales=en']];
const rows: Record<string, unknown>[] = [];
for (const t of targets) {
	for (const flags of flagsets) {
		const [target, exe] = t.split('@');
		const name = `${which}-${target}${exe ? '-canaryexe' : ''}${flags.length ? '-' + flags.join('').replace(/[-=]/g, '') : ''}`;
		const outfile = join(OUT, name);
		for (const f of [outfile, outfile + '.exe']) if (existsSync(f)) rmSync(f);
		const cmd = [CANARY, 'build', '--compile', `--target=${target}`, ...(exe ? [`--compile-executable-path=${exe}`] : []), ...flags, entry, '--outfile', outfile];
		const t0 = performance.now();
		const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: 300_000 });
		const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
		await p.exited;
		const ms = Math.round(performance.now() - t0);
		const file = [outfile, outfile + '.exe'].find(existsSync);
		const lines = (o + e).split('\n').filter((l) => /error|compile|warn: (?!TS1000)/i.test(l));
		const row = { target, canary_runtime: !!exe, flags: flags.join(' '), ok: p.exitCode === 0 && !!file, exit: p.exitCode, ms, mb: file ? +(statSync(file).size / 1e6).toFixed(2) : null, out: lines.slice(-3).join(' | ').slice(0, 400) };
		rows.push(row);
		console.log(JSON.stringify(row));
	}
}
await Bun.write(join(ROOT, `results/cross-${which}.json`), JSON.stringify(rows, null, 2));
