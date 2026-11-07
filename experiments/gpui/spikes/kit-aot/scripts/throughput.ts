// Steady-state SSR throughput with ApacheBench (ships with macOS): keep-alive, 32 concurrent.
//   bun scripts/throughput.ts kit-a kit-f kit-g
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = join(import.meta.dir, '..');
const TAG = process.env.KIT_AOT_TAG ? `-${process.env.KIT_AOT_TAG}` : '';
const OUT = join(ROOT, `out${TAG}`);
const names = process.argv.slice(2);
const N = Number(process.env.N ?? 20000);
const C = Number(process.env.C ?? 32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rows: Record<string, unknown>[] = [];
for (const name of names) {
	const path = join(OUT, name);
	if (!existsSync(path)) continue;
	const proc = Bun.spawn([path], { env: { ...process.env, PORT: '42777', HOST: '127.0.0.1' }, stdout: 'ignore', stderr: 'ignore' });
	for (let i = 0; i < 500; i++) {
		try {
			if ((await fetch('http://127.0.0.1:42777/')).ok) break;
		} catch {}
		await sleep(5);
	}
	const ab = (url: string, n: number) => {
		const r = Bun.spawnSync(['ab', '-q', '-k', '-n', String(n), '-c', String(C), url]);
		const out = r.stdout.toString();
		return {
			rps: Number(out.match(/Requests per second:\s+([\d.]+)/)?.[1]),
			p50: Number(out.match(/\s50%\s+(\d+)/)?.[1]),
			p99: Number(out.match(/\s99%\s+(\d+)/)?.[1]),
			// ab counts a body-length change as "failed"; /api/stats has a varying uptime field,
			// so only Connect/Receive/Exceptions are real errors
			errors: ['Connect', 'Receive', 'Exceptions'].reduce(
				(n, k) => n + Number(out.match(new RegExp(k + ': (\\d+)'))?.[1] ?? 0),
				0
			),
			non2xx: Number(out.match(/Non-2xx responses:\s+(\d+)/)?.[1] ?? 0)
		};
	};
	ab('http://127.0.0.1:42777/', 2000); // warm-up (lets the JIT variants tier up)
	const ssr = ab('http://127.0.0.1:42777/', N);
	const api = ab('http://127.0.0.1:42777/api/stats', N);
	const rss = Number(Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(proc.pid)]).stdout.toString().trim());
	proc.kill('SIGKILL');
	await proc.exited;
	const row = { name, ssr, api, rss_after_mb: +(rss / 1024).toFixed(1) };
	rows.push(row);
	console.log(JSON.stringify(row));
	await sleep(300);
}
await Bun.write(join(ROOT, `results/throughput${TAG}.json`), JSON.stringify(rows, null, 2));
