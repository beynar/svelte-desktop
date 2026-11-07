/**
 * Regression: a perpetual animation (CSS `animation: … infinite`, driven by
 * the rAF↔frame loop) must not livelock the JS event loop.
 *
 * The failure this guards: `Element.animate`'s apply() flushed the op stream
 * synchronously. On the real renderer every applyBatch ends in a synchronous
 * draw (test-support flush_effects draws dirty windows at end of update),
 * which emits a "frame" event → tickRaf → step → apply → flush → draw →
 * frame → … — a render loop at raw task speed (~11kHz) that starves every
 * other task. The loop must instead cross emit's setTimeout boundary each
 * cycle, pacing renders to ~task/refresh rate.
 *
 * Asserts, over ~3s of real-window runtime with an infinite animation live:
 *   - mount completes and the pump loop keeps turning (renderer.tick runs)
 *   - a plain setInterval heartbeat keeps firing (event loop not starved)
 *   - applyBatch calls stay bounded — paced, not one-per-step at task speed
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot, setViewport, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = '') => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

installGlobals();
const renderer = new GpuixRenderer((err: unknown, payload: unknown) => {
	if (!err) dispatchPayload(payload);
});
setRenderer(renderer);

let batches = 0;
const origBatch = renderer.applyBatch.bind(renderer);
(renderer as { applyBatch: (j: string) => unknown }).applyBatch = (json: string) => {
	batches++;
	return origBatch(json);
};

renderer.init({ title: 'anim loop probe', width: 800, height: 600 });
setViewport(800, 560);

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const { default: App } = await import('./gen/cases/motion.js');
mount(App, { target });
flush();

let heartbeats = 0;
const hb = setInterval(() => heartbeats++, 250);

let ticks = 0;
const t0 = performance.now();
const loop = () => {
	const running = renderer.tick();
	drainAfterRender();
	ticks++;
	if (running && performance.now() - t0 < 3000) setImmediate(loop);
	else finish();
};
function finish() {
	clearInterval(hb);
	const elapsed = performance.now() - t0;
	const rate = batches / (elapsed / 1000);
	ok(ticks > 100, `pump loop kept turning (${ticks} ticks)`);
	ok(heartbeats >= 8, `setInterval heartbeat stayed alive (${heartbeats} in ${(elapsed / 1000).toFixed(1)}s)`);
	// Livelocked this was ~11k/sec — every step flushed a synchronous draw.
	// Paced, it sits near the refresh/task cadence; 2000/sec is generous
	// headroom for fast machines without admitting the task-speed loop.
	ok(rate < 2000, `render loop paced (${rate.toFixed(0)} batches/s)`, `— task-speed storm would be ~10k/s`);
	console.log(`\n${pass} pass, ${fail} fail`);
	process.exit(fail ? 1 : 0);
}
loop();
