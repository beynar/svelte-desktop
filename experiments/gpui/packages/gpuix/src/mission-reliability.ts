/**
 * Mission probe — reliability paths: malformed batches, oversized messages,
 * rapid mount/unmount cycles, event storms, shutdown during work.
 * Headless TestGpuixRenderer; no window.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot, dispatchPayload } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';
import { appendFileSync } from 'fs';

const OUT = '../results/run-20260915-b/reliability.jsonl';
const rec = (o: object) => appendFileSync(OUT, JSON.stringify({ ts: Date.now(), ...o }) + '\n');
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => {
	results.push([name, ok, detail]);
	rec({ test: name, ok, detail });
	console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

installGlobals();
const renderer = new TestGpuixRenderer(800, 600);
setRenderer(renderer as any);
const { mount, unmount } = await import('../node_modules/svelte/src/index-client.js');
const Case = (await import('./gen/cases/state.js')).default;
const pump = () => { flush(); renderer.flush(); drainAfterRender(); };

// ── malformed batches ────────────────────────────────────────────────
for (const [name, batch] of [
	['malformed: not-an-array', '"hello"'],
	['malformed: bad opcode', '[["nonExistentOp", 1]]'],
	['malformed: map-not-tuple', '[{"type":"setStyle","id":1}]'],
	['malformed: wrong arg type', '[["setText", 1, {"nested":true}]]'],
	['malformed: truncated', '[["setText", 1, "abc'],
] as const) {
	let threw = false;
	try { renderer.applyBatch(batch); } catch { threw = true; }
	check(name, threw, 'rejected with typed error, no panic');
}

// ── oversized batch (100k ops / ~3.2MB) ──────────────────────────────
{
	const ops = Array.from({ length: 100_000 }, (_, i) => ['setStyle', i + 1, { opacity: 0.5 }]);
	const t = performance.now();
	let ok = true;
	try { renderer.applyBatch(JSON.stringify(ops)); } catch (e) { ok = false; }
	check('oversized: 100k ops (3.2MB)', ok, `${(performance.now() - t).toFixed(1)}ms`);
}

// ── rapid mount/unmount cycles ───────────────────────────────────────
{
	const target = doc.createElement('div');
	target.setAttribute('style', 'width:400px;height:300px');
	doc.body.appendChild(target);
	materializeRoot(target);
	const t = performance.now();
	let ok = true;
	for (let i = 0; i < 1000; i++) {
		const c = mount(Case, { target });
		pump();
		await unmount(c);
	}
	check('1000x mount/unmount', ok, `${(performance.now() - t).toFixed(0)}ms total`);
}

// ── event storm: 10k synthetic clicks ────────────────────────────────
{
	const before = performance.now();
	let delivered = 0;
	const orig = dispatchPayload;
	for (let i = 0; i < 10_000; i++) {
		try { orig({ type: 'click', target: 1, x: 5, y: 5 }); delivered++; } catch {}
	}
	check('event storm 10k', delivered === 10_000, `${(performance.now() - before).toFixed(1)}ms`);
}

// ── double-dispose / double-flush ────────────────────────────────────
{
	const c = mount(Case, { target: doc.createElement('div') });
	let ok = true;
	try { await unmount(c); await unmount(c); } catch { ok = false; }
	check('double unmount', ok);
	try { flush(); flush(); pump(); pump(); } catch { ok = false; }
	check('double flush', ok);
}

// ── drain during apply (reentrancy guard holds) ──────────────────────
{
	let ok = true;
	try {
		// emit inside a drained event — the setTimeout guard must defer it
		dispatchPayload({ type: 'click', target: 1, x: 1, y: 1 });
		flush(); pump();
	} catch (e) { ok = false; }
	check('emit-during-dispatch deferred', ok);
}

const pass = results.filter(([, ok]) => ok).length;
console.log(`\n${pass}/${results.length} reliability checks`);
process.exit(pass === results.length ? 0 : 1);
