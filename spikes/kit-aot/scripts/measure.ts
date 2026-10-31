// Launch-time / memory / functional measurement for every built executable.
//
//   bun scripts/measure.ts               # every binary in out/ (+ build-adapter/server if present)
//   bun scripts/measure.ts kit-g hello   # only matching names
//
// Per binary:
//   - RUNS (5) launches: time from spawn to the first HTTP 200 on `/` (polled every 2 ms)
//   - one more launch: RSS 1 s after ready, functional checks, 200 sequential SSR requests, RSS again
import * as devalue from 'devalue';
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// The exact serializer the SvelteKit client uses for JS-enhanced form() submissions.
import {
	serialize_binary_form,
	BINARY_FORM_CONTENT_TYPE
} from '../node_modules/@sveltejs/kit/src/runtime/form-utils.js';

const ROOT = join(import.meta.dir, '..');
const TAG = process.env.KIT_AOT_TAG ? `-${process.env.KIT_AOT_TAG}` : '';
const OUT = join(ROOT, `out${TAG}`);
const RESULTS = join(ROOT, 'results');
const PORT = 42777; // paths.origin is pinned to http://localhost:42777 (CSRF origin check)
const BASE = `http://localhost:${PORT}`;
const RUNS = Number(process.env.RUNS ?? 5);

const binaries: { name: string; path: string }[] = readdirSync(OUT)
	.filter((f) => !f.includes('.') && statSync(join(OUT, f)).isFile())
	.sort()
	.map((name) => ({ name, path: join(OUT, name) }));
if (!TAG && existsSync(join(ROOT, 'build-adapter/server')))
	binaries.unshift({ name: 'kit-0-adapter-own-compile', path: join(ROOT, 'build-adapter/server') });

const filter = process.argv.slice(2);
const selected = filter.length ? binaries.filter((b) => filter.some((f) => b.name.includes(f))) : binaries;

// remote function ids, scraped from the client bundle like the browser would receive them
const nodes_dir = join(ROOT, '.svelte-kit/output/client/_app/immutable/nodes');
const client_src = readdirSync(nodes_dir)
	.map((f) => readFileSync(join(nodes_dir, f), 'utf8'))
	.join('\n');
const remote_id = (name: string) => {
	const m = client_src.match(new RegExp('[`"\']([A-Za-z0-9_-]+/' + name + ')[`"\']'));
	if (!m) throw new Error(`remote id for ${name} not found`);
	return m[1];
};
const ID = { getState: remote_id('getState'), increment: remote_id('increment'), addNote: remote_id('addNote') };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const rss_kb = (pid: number) => {
	if (existsSync(`/proc/${pid}/status`)) {
		// Linux (container images often ship without `ps`); VmRSS is what `ps -o rss` reports
		const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
		return m ? Number(m[1]) : null;
	}
	const r = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)]);
	return Number(r.stdout.toString().trim()) || null;
};

async function port_free() {
	for (let i = 0; i < 500; i++) {
		try {
			await fetch(BASE, { signal: AbortSignal.timeout(50) });
			await sleep(10);
		} catch {
			return;
		}
	}
	throw new Error('port still busy');
}

async function launch(path: string, log: string) {
	await port_free();
	const t0 = performance.now();
	const proc = Bun.spawn([path], {
		env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
		stdout: Bun.file(log),
		stderr: Bun.file(log + '.err')
	});
	let ready_ms: number | null = null;
	while (performance.now() - t0 < 15000) {
		if (proc.exitCode !== null) break;
		try {
			const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(500) });
			await res.arrayBuffer();
			if (res.status === 200) {
				ready_ms = performance.now() - t0;
				break;
			}
		} catch {}
		await sleep(2);
	}
	return { proc, ready_ms };
}

async function stop(proc: Bun.Subprocess) {
	proc.kill('SIGKILL');
	await proc.exited;
}

type Check = { name: string; ok: boolean; detail?: string };

async function functional(is_hello: boolean): Promise<Check[]> {
	const checks: Check[] = [];
	const check = async (name: string, fn: () => Promise<string | true>) => {
		try {
			const r = await fn();
			checks.push(r === true ? { name, ok: true } : { name, ok: false, detail: r });
		} catch (e) {
			checks.push({ name, ok: false, detail: String(e).slice(0, 300) });
		}
	};

	if (is_hello) {
		await check('hello', async () => ((await (await fetch(BASE)).text()) === 'hello world' ? true : 'bad body'));
		return checks;
	}

	let css_href = '';
	await check('ssr /', async () => {
		const res = await fetch(BASE + '/');
		const html = await res.text();
		css_href = html.match(/href="\.\/(_app\/immutable\/assets\/[^"]+\.css)"/)?.[1] ?? '';
		if (res.status !== 200) return `status ${res.status}`;
		for (const s of ['kit-aot spike: SSR home', 'seed note from bun:sqlite', 'id="counter">0<'])
			if (!html.includes(s)) return `missing ${JSON.stringify(s)}`;
		return true;
	});

	await check('remote query (GET)', async () => {
		const res = await fetch(`${BASE}/_app/remote/${ID.getState}`, {
			headers: { 'x-sveltekit-pathname': '/', 'x-sveltekit-search': '' }
		});
		const body = await res.json();
		if (body.type !== 'result') return JSON.stringify(body).slice(0, 200);
		const data = devalue.parse(body.data);
		return data._?.notes?.[0]?.text === 'seed note from bun:sqlite' ? true : JSON.stringify(data).slice(0, 200);
	});

	await check('remote command (POST json)', async () => {
		const res = await fetch(`${BASE}/_app/remote/${ID.increment}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: BASE,
				'x-sveltekit-pathname': '/',
				'x-sveltekit-search': ''
			},
			body: JSON.stringify({ payload: '', refreshes: [] })
		});
		const body = await res.json();
		if (body.type !== 'result') return JSON.stringify(body).slice(0, 200);
		const data = devalue.parse(body.data);
		return data._?.counter === 1 ? true : JSON.stringify(data).slice(0, 200);
	});

	await check('remote form (no-JS native POST)', async () => {
		const html = await (await fetch(BASE + '/')).text();
		const action = html.match(/<form method="POST" action="([^"]+)"/)?.[1];
		const field = html.match(/<input name="([^"]+)"/)?.[1];
		if (!action || !field) return 'form not found in SSR html';
		const res = await fetch(BASE + '/' + action, {
			method: 'POST',
			headers: { accept: 'text/html', origin: BASE, 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ [field]: 'native form note' })
		});
		const out = await res.text();
		return res.status === 200 && out.includes('native form note') ? true : `status ${res.status} ${out.slice(0, 120)}`;
	});

	await check('remote form (JS-enhanced binary POST)', async () => {
		const { blob } = serialize_binary_form({ text: 'enhanced form note' }, { remote_refreshes: [] });
		const res = await fetch(`${BASE}/_app/remote/${ID.addNote}`, {
			method: 'POST',
			headers: {
				'content-type': BINARY_FORM_CONTENT_TYPE,
				origin: BASE,
				'x-sveltekit-pathname': '/',
				'x-sveltekit-search': ''
			},
			body: blob
		});
		const body = await res.json();
		if (body.type !== 'result') return JSON.stringify(body).slice(0, 200);
		const html = await (await fetch(BASE + '/')).text();
		return html.includes('enhanced form note') && html.includes('id="counter">1<')
			? true
			: 'mutation not visible in SSR';
	});

	await check('prerendered /about', async () => {
		const res = await fetch(BASE + '/about');
		const t = await res.text();
		return res.status === 200 && t.includes('About (prerendered)') ? true : `status ${res.status}`;
	});

	await check('static /logo.svg', async () => {
		const res = await fetch(BASE + '/logo.svg');
		const t = await res.text();
		return res.status === 200 && res.headers.get('content-type')?.includes('svg') && t.includes('<svg')
			? true
			: `status ${res.status} ${res.headers.get('content-type')}`;
	});

	await check('client css asset', async () => {
		if (!css_href) return 'no css link in html';
		const res = await fetch(`${BASE}/${css_href}`);
		const t = await res.text();
		return res.status === 200 && t.includes('#ff3e00') ? true : `status ${res.status}`;
	});

	await check('+server.ts json', async () => {
		const res = await fetch(BASE + '/api/stats?echo=hi');
		const j = await res.json();
		return j.ok === true && j.echo === 'hi' ? true : JSON.stringify(j);
	});

	await check('404 page', async () => {
		const res = await fetch(BASE + '/nope');
		await res.text();
		return res.status === 404 ? true : `status ${res.status}`;
	});

	return checks;
}

const results: Record<string, unknown>[] = [];
for (const b of selected) {
	const is_hello = b.name.startsWith('hello');
	const log = join(RESULTS, `run${TAG}-${b.name}.log`);
	const ready: (number | null)[] = [];
	for (let i = 0; i < RUNS; i++) {
		const { proc, ready_ms } = await launch(b.path, log);
		ready.push(ready_ms === null ? null : +ready_ms.toFixed(1));
		await stop(proc);
	}

	const { proc, ready_ms } = await launch(b.path, log);
	let rss_idle = null,
		rss_after = null,
		checks: Check[] = [],
		rps = null;
	if (ready_ms !== null) {
		await sleep(1000);
		rss_idle = rss_kb(proc.pid);
		checks = await functional(is_hello);
		const t0 = performance.now();
		for (let i = 0; i < 200; i++) await (await fetch(BASE + '/')).arrayBuffer();
		rps = Math.round(200 / ((performance.now() - t0) / 1000));
		await sleep(200);
		rss_after = rss_kb(proc.pid);
	}
	const exited = proc.exitCode;
	await stop(proc);
	const stderr = existsSync(log + '.err') ? readFileSync(log + '.err', 'utf8').trim() : '';

	const ok_ready = ready.filter((x): x is number => x !== null);
	const r = {
		name: b.name,
		ready_ms_runs: ready,
		ready_ms_median: ok_ready.length ? +median(ok_ready).toFixed(1) : null,
		rss_idle_mb: rss_idle && +(rss_idle / 1024).toFixed(1),
		rss_after_200_mb: rss_after && +(rss_after / 1024).toFixed(1),
		ssr_rps_sequential: rps,
		checks_passed: `${checks.filter((c) => c.ok).length}/${checks.length}`,
		failed_checks: checks.filter((c) => !c.ok),
		exited_early: exited,
		stderr: stderr.slice(0, 2000)
	};
	results.push(r);
	console.log(
		`${b.name.padEnd(28)} ready(med)=${String(r.ready_ms_median).padStart(6)}ms runs=${JSON.stringify(ready)} rss=${r.rss_idle_mb}->${r.rss_after_200_mb}MB rps=${rps} checks=${r.checks_passed}` +
			(r.failed_checks.length ? `\n    FAILED: ${JSON.stringify(r.failed_checks)}` : '') +
			(stderr ? `\n    stderr: ${stderr.slice(0, 400)}` : '')
	);
}

const file = join(RESULTS, `measure${TAG}.json`);
const prev: Record<string, unknown>[] = existsSync(file) ? await Bun.file(file).json() : [];
const merged = [...prev.filter((p) => !results.some((r) => r.name === p.name)), ...results];
await Bun.write(file, JSON.stringify(merged, null, 2));
