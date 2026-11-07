/**
 * Repro: /animations scroll hitch. Real window, scrollable column of cards
 * with a perpetual animation running (the marquee pattern) — the same paced
 * render loop the page sustains. Simulate a trackpad scroll burst and measure
 * per-tick cost + frame stats before/during.
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot, setViewport, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

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

renderer.init({ title: 'scroll perf repro', width: 800, height: 600 });
setViewport(800, 560);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Draws are display-link-paced now — the runloop must be pumped for vsync
// steps to land, exactly like the app entry's tick(16) loop. Back-to-back
// `await sleep()` alone never services the main dispatch queue.
const pumpUntil = async (ms: number) => {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		(renderer as any).tick(4);
		drainAfterRender();
		await sleep(0);
	}
};

const root = doc.createElement('div');
root.setAttribute('style', 'width:800px;height:600px');
doc.body.appendChild(root);
materializeRoot(root);

const scroll = doc.createElement('div');
scroll.setAttribute(
	'style',
	'width:800px;height:600px;overflow-y:scroll;display:flex;flex-direction:column;gap:16px;padding:16px',
);
root.appendChild(scroll);

for (let i = 0; i < 20; i++) {
	const card = doc.createElement('div');
	card.setAttribute(
		'style',
		'height:120px;border-radius:14px;background-color:#1c1e26;border:1px solid #2a2d3a;padding:16px;flex:none',
	);
	const label = doc.createElement('div');
	label.setAttribute('style', 'font-size:14px;color:#e8eaf2');
	label.textContent = `card ${i} — transition demo panel with a few words of text`;
	card.appendChild(label);
	const sub = doc.createElement('div');
	sub.setAttribute('style', 'font-size:11px;color:#8a8fa3;margin-top:6px');
	sub.textContent = 'sub-label row: duration · easing · direction';
	card.appendChild(sub);
	scroll.appendChild(card);
}
await pumpUntil(400);
await sleep(0);

// perpetual animations like the page's marquee/cssspin + toggles — the
// paced render loop under realistic load
for (let i = 0; i < 8; i++) {
	(scroll.childNodes[i * 2] as any).animate(
		[
			{ transform: 'translateX(0px)', opacity: '0.4' },
			{ transform: `translateX(${40 + i * 5}px)`, opacity: '1' },
		],
		{ duration: 600 + i * 90, iterations: Infinity, direction: 'alternate', easing: 'linear' },
	);
}

const stats = () => (renderer as any).getDebugFrameOverlayStats?.();

await pumpUntil(1500); // warm up: paced loop running
const base = stats();
const baseBatches = batches;
await pumpUntil(1000);
const idle = stats();
console.log(
	`idle: batches=${batches - baseBatches}/s frames=${idle.frames - base.frames}/s p90=${idle.p90Ms?.toFixed(1)}ms p99=${idle.p99Ms?.toFixed(1)}ms max=${idle.maxMs?.toFixed(1)}ms`,
);

// scroll burst — 40 wheel ticks back-to-back, each measured
const pre = stats();
const preBatches = batches;
const t0 = performance.now();
const tickTimes: number[] = [];
for (let i = 0; i < 40; i++) {
	const t = performance.now();
	(renderer as any).simulateScrollWheel(400, 300, 0, -24, null, null);
	tickTimes.push(performance.now() - t);
	await pumpUntil(8); // ~80Hz cadence like a flick; pumps vsync steps
}
const scrollMs = performance.now() - t0;
const post = stats();
tickTimes.sort((a, b) => a - b);
console.log(
	`scroll burst: 40 ticks in ${scrollMs.toFixed(0)}ms — per-tick p50=${tickTimes[20]!.toFixed(1)}ms p90=${tickTimes[36]!.toFixed(1)}ms max=${tickTimes[39]!.toFixed(1)}ms`,
);
console.log(
	`frames during scroll: ${post.frames - pre.frames} in ${scrollMs.toFixed(0)}ms (${(((post.frames - pre.frames) / scrollMs) * 1000).toFixed(0)}/s) — p90=${post.p90Ms?.toFixed(1)}ms p99=${post.p99Ms?.toFixed(1)}ms max=${post.maxMs?.toFixed(1)}ms batches=${batches - preBatches}`,
);

await pumpUntil(500);
console.log('done');
(renderer as any).closeAllWindows?.();
await sleep(200);
process.exit(0);
