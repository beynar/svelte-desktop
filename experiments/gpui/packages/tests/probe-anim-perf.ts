/** Perf probe: op volume + applyBatch cost during a live transition.
 * Numbers land in .agent/JOURNAL.md — rerun to re-measure.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';
import * as native from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// instrument applyBatch: count calls, ops, wall time. napi instances
// aren't guaranteed extensible — intercept via a Proxy rebind (same as
// probe-raf) instead of patching the method.
let batches = 0, opsTotal = 0, batchNs = 0, maxOps = 0, flushNs = 0, flushes = 0;
setRenderer(
	new Proxy(renderer as any, {
		get(t, p) {
			if (p === 'applyBatch')
				return (json: string) => {
					const t0 = performance.now();
					const r = t.applyBatch(json);
					const dt = performance.now() - t0;
					batches++; batchNs += dt;
					try { const n = JSON.parse(json).length; opsTotal += n; maxOps = Math.max(maxOps, n); } catch {}
					return r;
				};
			const v = t[p];
			return typeof v === 'function' ? v.bind(t) : v;
		},
	}) as any,
);

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const { default: Slide } = await import('./gen/cases/slide.js');
mount(Slide, { target });
await sleep(60);
for (const ev of renderer.drainEvents()) dispatchPayload(ev);
flush(); renderer.flush(); drainAfterRender();

// reset counters — measure only the transition window
batches = 0; opsTotal = 0; batchNs = 0; maxOps = 0; flushNs = 0; flushes = 0;

// click 'side' → 160ms outro on width
const tree = JSON.parse(renderer.getAutomationTree());
let hit: any = null;
const walk = (n: any) => { if (hit) return; if (n.type === 'text' && n.text === 'side') hit = { x: n.bounds.x + 4, y: n.bounds.y + 4 }; n.children?.forEach(walk); };
walk(tree);
const t0 = performance.now();
renderer.simulateClick(hit.x, hit.y);
while (performance.now() - t0 < 400) {
	for (const ev of renderer.drainEvents()) dispatchPayload(ev);
	flush();
	const f0 = performance.now(); renderer.flush(); flushNs += performance.now() - f0; flushes++;
	drainAfterRender();
	await sleep(4);
}
const wall = performance.now() - t0;
console.log(`transition window: ${wall.toFixed(0)}ms`);
console.log(`applyBatch calls: ${batches}  (${(batches / (wall / 1000)).toFixed(1)}/s)`);
console.log(`total ops: ${opsTotal}  max batch: ${maxOps}`);
console.log(`applyBatch total: ${batchNs.toFixed(2)}ms  avg ${(batchNs / batches).toFixed(3)}ms/call`);
console.log(`JS-side anim cost share: ${(100 * batchNs / wall).toFixed(1)}% of wall`);
console.log(`renderer.flush: ${flushes} calls, ${flushNs.toFixed(2)}ms total, avg ${(flushNs / flushes).toFixed(3)}ms`);
