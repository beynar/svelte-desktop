/**
 * Diagnostic: mount the real motion case in a real window, then drive
 * simulate_scroll_wheel while pumping the runloop — measures the full
 * scroll→present chain under the vsync-paced renderer.
 *
 * Reports: mount→first-frame latency, per-tick dispatch cost, inter-frame
 * gaps during scroll, and draw durations (debug overlay stats).
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot, setViewport, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const frameTimes: number[] = [];
const renderer = new GpuixRenderer((err: unknown, payload: any) => {
	if (!err) {
		if (payload?.eventType === 'frame') frameTimes.push(performance.now());
		dispatchPayload(payload);
	}
});
setRenderer(renderer);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

renderer.init({ title: 'scroll cadence', width: 1000, height: 700 });
setViewport(1000, 660);

const stats = () => (renderer as any).getDebugFrameOverlayStats?.();

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);

// ── mount → first frame ─────────────────────────────────────────────
const mountT0 = performance.now();
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const { default: App } = await import('./gen/cases/motion.js');
mount(App, { target });
flush();
const mountDone = performance.now();

// pump until first frame event (the vsync draw)
let firstFrameAt: number | null = null;
while (firstFrameAt === null && performance.now() - mountT0 < 3000) {
	(renderer as any).tick(4);
	drainAfterRender();
	if (frameTimes.length) firstFrameAt = performance.now();
	await sleep(0);
}
console.log(`mount(): ${(mountDone - mountT0).toFixed(1)}ms  mount→first frame: ${(firstFrameAt! - mountT0).toFixed(1)}ms`);

// warm up — let intro transitions settle
{
	const end = performance.now() + 1500;
	while (performance.now() < end) {
		(renderer as any).tick(4);
		drainAfterRender();
		await sleep(0);
	}
}
const idleStats = stats();
console.log(`post-mount frame rate: ${(frameTimes.length / ((performance.now() - mountT0) / 1000)).toFixed(0)}/s · draw p90=${idleStats?.p90Ms?.toFixed(1)}ms`);

// ── scroll burst while pumping ──────────────────────────────────────
const scrollGapStart = frameTimes.length;
const tickTimes: number[] = [];
const scrollT0 = performance.now();
for (let i = 0; i < 60; i++) {
	const t = performance.now();
	(renderer as any).simulateScrollWheel(500, 350, 0, -24, null, null);
	tickTimes.push(performance.now() - t);
	// pump ~8ms — the app entry's tick(16) cadence
	const pe = performance.now() + 8;
	while (performance.now() < pe) {
		(renderer as any).tick(2);
		drainAfterRender();
	}
}
const scrollMs = performance.now() - scrollT0;
tickTimes.sort((a, b) => a - b);
const during = frameTimes.slice(scrollGapStart);
const gaps = during.slice(1).map((t, i) => t - during[i]).sort((a, b) => a - b);
const endStats = stats();
console.log(`scroll: 60 ticks in ${scrollMs.toFixed(0)}ms · per-tick p50=${tickTimes[30]!.toFixed(2)}ms p95=${tickTimes[57]!.toFixed(2)}ms`);
console.log(`frames during scroll: ${during.length} (${((during.length / scrollMs) * 1000).toFixed(0)}/s) · gap p50=${gaps[Math.floor(gaps.length / 2)]?.toFixed(1)}ms p90=${gaps[Math.floor(gaps.length * 0.9)]?.toFixed(1)}ms max=${gaps[gaps.length - 1]?.toFixed(1)}ms`);
console.log(`draw stats end: p90=${endStats?.p90Ms?.toFixed(1)}ms p99=${endStats?.p99Ms?.toFixed(1)}ms max=${endStats?.maxMs?.toFixed(1)}ms frames=${endStats?.frames}`);

(renderer as any).closeAllWindows?.();
await sleep(100);
process.exit(0);
