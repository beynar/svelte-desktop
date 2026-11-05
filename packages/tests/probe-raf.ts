/**
 * Probe: requestAnimationFrame is driven by the native `frame` event —
 * one tick per painted frame — not a JS timer. Verifies queueing,
 * ordering, next-frame deferral, cancellation, the requestFrame op
 * reaching native, and the watchdog fallback when nothing renders.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
flush();
renderer.flush();
for (const ev of renderer.drainEvents()) dispatchPayload(ev);

let pass = 0,
	fail = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
	ok ? pass++ : fail++;
};

/** Flush pending ops, render a frame, deliver its events to gdom. */
async function frame() {
	await sleep(2); // emit() defers the op flush to a macrotask
	flush();
	renderer.flush();
	for (const ev of renderer.drainEvents()) dispatchPayload(ev);
	drainAfterRender();
}

// ── the requestFrame op reaches native ────────────────────────────────
// napi instances may be non-extensible — intercept via a Proxy rebind
// instead of patching the method.
const batches: string[] = [];
setRenderer(
	new Proxy(renderer as any, {
		get(t, p) {
			if (p === 'applyBatch')
				return (json: string) => {
					batches.push(json);
					return t.applyBatch(json);
				};
			const v = t[p];
			return typeof v === 'function' ? v.bind(t) : v;
		},
	}) as any,
);

let ts: number | null = null;
requestAnimationFrame((t) => {
	ts = t;
});
await frame();
check(batches.some((b) => b.includes('requestFrame')), 'requestFrame op reached native');
check(ts !== null, 'rAF callback ticked on the native frame event');
check(typeof ts === 'number' && (ts as number) > 0, `timestamp is DOMHighResTimeStamp (${ts?.toFixed(1)})`);

// ── queued callbacks share one frame, in order ───────────────────────
const order: string[] = [];
requestAnimationFrame(() => order.push('a'));
requestAnimationFrame(() => order.push('b'));
await frame();
check(order.join(',') === 'a,b', `queued callbacks ran together in order (${order})`);

// ── a callback registered during delivery runs on the NEXT frame ─────
const seq: string[] = [];
requestAnimationFrame(() => {
	seq.push('outer');
	requestAnimationFrame(() => seq.push('inner'));
});
await frame();
check(seq.join(',') === 'outer', `nested rAF deferred to next frame (${seq})`);
await frame();
check(seq.join(',') === 'outer,inner', `nested rAF ran on the next frame (${seq})`);

// ── cancellation ──────────────────────────────────────────────────────
let ran = false;
const id = requestAnimationFrame(() => {
	ran = true;
});
cancelAnimationFrame(id);
await frame();
check(!ran, 'cancelAnimationFrame prevents the tick');

// ── no render → no tick (the frame event is the only fast path) ──────
let ticks = 0;
requestAnimationFrame(() => ticks++);
await sleep(2);
flush(); // the requestFrame op lands, but nothing renders
for (const ev of renderer.drainEvents()) dispatchPayload(ev);
check(ticks === 0, 'no render → no tick within the watchdog window');

// ── watchdog: a renderer that never paints still completes the tick ──
await sleep(400); // 250ms watchdog + margin for a loaded event loop
check(ticks === 1, `watchdog ticked when no frame arrived (${ticks})`);

// ── a throwing callback doesn't kill its same-frame siblings ─────────
const afterThrow: string[] = [];
requestAnimationFrame(() => {
	afterThrow.push('x');
	throw new Error('boom');
});
requestAnimationFrame(() => afterThrow.push('y'));
await frame();
check(afterThrow.join(',') === 'x,y', `throwing cb doesn't kill siblings (${afterThrow})`);

// ── two windows' same-cycle frame events coalesce to one tick ────────
// A second window's render lands ~simultaneously — draining on each
// would run rAF at N× the vsync rate.
let wt = 0;
const wstep = () => {
	wt++;
	if (wt < 3) requestAnimationFrame(wstep);
};
requestAnimationFrame(wstep);
dispatchPayload({ elementId: 0x7fffff01, eventType: 'frame', windowId: 0 } as never);
dispatchPayload({ elementId: 0x7fffff01, eventType: 'frame', windowId: 1 } as never);
check(wt === 1, `same-cycle frames from two windows → one tick (${wt})`);
await sleep(6);
dispatchPayload({ elementId: 0x7fffff01, eventType: 'frame', windowId: 1 } as never);
check(wt === 2, `the other window's next cycle ticks again (${wt})`);
// re-anchor the suppression tracker on a real wid-0 frame — needs ≥4ms
// since the synthetic wid-1 tick or the cross-window rule eats it too
await sleep(6);
await frame();
check(wt === 3, `wstep chain finished on real frames (${wt})`);

// ── sustained chain: self-requeueing rAF advances one step per frame ──
let chain = 0;
const step = () => {
	chain++;
	if (chain < 5) requestAnimationFrame(step);
};
requestAnimationFrame(step);
for (let i = 0; i < 5; i++) await frame();
check(chain === 5, `self-requeueing rAF advanced once per frame (${chain})`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
