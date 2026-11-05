/**
 * Diagnostic 2: drive native ops from a plain setInterval (NOT the rAF↔frame
 * loop). If frames land every vsync after each batch, the display-link pacing
 * works and the anim loop's self-paced cycle is what needs tuning.
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot, setViewport, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const frameTimes: number[] = [];
const dirtyTimes: number[] = [];

const renderer = new GpuixRenderer((err: unknown, payload: any) => {
	if (!err) {
		if (payload?.eventType === 'frame') frameTimes.push(performance.now());
		dispatchPayload(payload);
	}
});
setRenderer(renderer);

const origBatch = renderer.applyBatch.bind(renderer);
(renderer as { applyBatch: (j: string) => unknown }).applyBatch = (json: string) => {
	dirtyTimes.push(performance.now());
	return origBatch(json);
};

renderer.init({ title: 'frame cadence probe', width: 800, height: 600 });
setViewport(800, 560);

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
flush();

// Drive a style mutation every 8ms — faster than any vsync — and count how
// often a frame event comes back. Coalescing SHOULD cap this at display rate.
const el = doc.createElement('div');
el.setAttribute('style', 'width: 50px; height: 50px; background: #ff0000');
target.appendChild(el);

let n = 0;
const driver = setInterval(() => {
	n++;
	el.style.opacity = String(((n % 60) + 1) / 61);
}, 8);

const t0 = performance.now();
const loop = () => {
	const running = renderer.tick();
	drainAfterRender();
	if (running && performance.now() - t0 < 8000) setImmediate(loop);
	else report();
};

function report() {
	clearInterval(driver);
	const secs = (performance.now() - t0) / 1000;
	console.log(`elapsed ${secs.toFixed(2)}s`);
	console.log(`frames: ${frameTimes.length} (${(frameTimes.length / secs).toFixed(0)}/s)`);
	console.log(`batches (setStyle ops): ${batchCount()} (${(batchCount() / secs).toFixed(0)}/s)`);
	const gaps = frameTimes.slice(1).map((t, i) => t - frameTimes[i]).sort((a, b) => a - b);
	if (gaps.length) {
		console.log(`inter-frame gap p50=${gaps[Math.floor(gaps.length / 2)]?.toFixed(1)}ms p10=${gaps[Math.floor(gaps.length * 0.1)]?.toFixed(1)}ms p90=${gaps[Math.floor(gaps.length * 0.9)]?.toFixed(1)}ms`);
	}
	// dirty→frame latency
	const lats: number[] = [];
	for (const ft of frameTimes) {
		let i = dirtyTimes.length - 1;
		while (i >= 0 && dirtyTimes[i] > ft) i--;
		if (i >= 0) lats.push(ft - dirtyTimes[i]);
	}
	lats.sort((a, b) => a - b);
	if (lats.length) console.log(`dirty→frame latency p50=${lats[Math.floor(lats.length / 2)]?.toFixed(1)}ms p90=${lats[Math.floor(lats.length * 0.9)]?.toFixed(1)}ms`);
	process.exit(0);
}
function batchCount() { return dirtyTimes.length; }
loop();
