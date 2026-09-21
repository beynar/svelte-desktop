/**
 * Drift diagnostic — boots host.js (real app, real window, this process),
 * navigates to /animations, then samples every 10s for ~150s: frame cadence,
 * tick/JS-turn cost, applyBatch load, heap, and a DOM walk counting live
 * anims / css anims / animFrames layers / nodes. Degradation shows up as a
 * column drifting upward while the scene itself is static.
 *
 * Run: cd app && bun ../packages/vite/runtime/probe-drift.js
 *   env: SECONDS (default 150), INTERVAL (default 10), RAISE=1 to front the
 *   window (display-link path; default leaves it occluded → fallback path).
 */
import { execSync } from 'node:child_process';
process.env.SVELTE_NATIVE_ROOT ??= '/Users/arnaud/code/svelte-desktop/app';
process.env.SVELTE_NATIVE_DEVJSON ??= '/Users/arnaud/code/svelte-desktop/app/.svelte-native/dev.json';
await import('./host.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (globalThis.__svelteNativeHost ??= {});
const now = () => performance.now();

for (let i = 0; i < 400 && !(host.renderer && host.router); i++) await sleep(25);
if (!host.renderer) { console.error('no renderer'); process.exit(1); }
const renderer = host.renderer;

await sleep(800);
if (process.env.RAISE === '1') {
	try { execSync(`swift /tmp/axraise.swift ${process.pid}`); } catch {}
}

// ── instrumentation ──────────────────────────────────────────────────
const frames = [];
const origDispatch = host.dispatch?.bind(host);
host.dispatch = (payload) => {
	if (payload?.eventType === 'frame') frames.push(now());
	origDispatch?.(payload);
};
const ticks = [];
const tickAt = [];
const origTick = renderer.tick.bind(renderer);
renderer.tick = (ms) => {
	const t = now();
	const r = origTick(ms);
	ticks.push(now() - t);
	tickAt.push(t);
	return r;
};
let batchMs = 0, batchOps = 0, batches = 0;
const origApply = renderer.applyBatch.bind(renderer);
renderer.applyBatch = (json) => {
	const t = now();
	const r = origApply(json);
	batchMs += now() - t;
	batchOps += JSON.parse(json).length;
	batches++;
	return r;
};

const pctl = (a, p) => {
	if (!a.length) return 0;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

// Hop latencies: for each frame event, time since the last tick() return
// (≈ emit→dispatch), and dispatch→next applyBatch entry (the rAF+flush hop).
const hopEmitToDispatch = [];
const hopDispatchToBatch = [];
let lastTickEnd = 0;
let lastFrameDispatch = 0;
const origTick2 = renderer.tick.bind(renderer);
renderer.tick = (ms) => {
	const r = origTick2(ms);
	lastTickEnd = now();
	return r;
};
const _od = host.dispatch;
host.dispatch = (payload) => {
	const r = _od?.(payload);
	if (payload?.eventType === 'frame') {
		lastFrameDispatch = now();
		if (lastTickEnd) hopEmitToDispatch.push(lastFrameDispatch - lastTickEnd);
	}
	return r;
};
const _oa = renderer.applyBatch.bind(renderer);
renderer.applyBatch = (json) => {
	if (lastFrameDispatch && lastFrameDispatch > (hopDispatchToBatch._mark ?? 0)) {
		hopDispatchToBatch.push(now() - lastFrameDispatch);
		hopDispatchToBatch._mark = lastFrameDispatch;
	}
	return _oa(json);
};

// DOM walk — count anim-bearing state on the real gdom tree.
const walkCounts = () => {
	let nodes = 0, liveAnims = 0, cssAnims = 0, layers = 0;
	const doc = globalThis.document;
	const stack = doc?.documentElement ? [doc.documentElement] : [];
	while (stack.length) {
		const n = stack.pop();
		nodes++;
		if (n._liveAnims?.size) liveAnims += n._liveAnims.size;
		if (n._cssAnim) cssAnims++;
		if (n.animFrames?.size) layers += n.animFrames.size;
		if (n.childNodes) stack.push(...n.childNodes);
	}
	return { nodes, liveAnims, cssAnims, layers };
};

await sleep(1200);
await host.router.goto('/animations');
await sleep(2000); // intros settle, perp anims running

const SECONDS = Number(process.env.SECONDS ?? 150);
const INTERVAL = Number(process.env.INTERVAL ?? 10);
console.log(' t(s) | fps  gap50  gap90  gapMax | tick50  tickMax  js50  jsMax | batch/s  ops/b   ms |  heapMB  gcMB | nodes anims css layers');
console.log('------+--------------------------------+---------------------------+----------------------+---------------+------------------------');

const t0 = now();
for (let t = 0; t < SECONDS; t += INTERVAL) {
	frames.length = 0; ticks.length = 0; tickAt.length = 0;
	batchMs = 0; batchOps = 0; batches = 0;
	await sleep(INTERVAL * 1000);

	const fps = frames.length / INTERVAL;
	const gaps = frames.slice(1).map((x, i) => x - frames[i]);
	const periods = [], jsTurns = [];
	for (let i = 1; i < tickAt.length; i++) {
		const p = tickAt[i] - tickAt[i - 1];
		periods.push(p);
		jsTurns.push(p - ticks[i - 1]);
	}
	const heap = process.memoryUsage().heapUsed / 1048576;
	globalThis.Bun?.gc?.(true);
	const gcHeap = process.memoryUsage().heapUsed / 1048576;
	const c = walkCounts();

	console.log(
		`${String(Math.round(now() - t0) / 1000).padStart(5)} |` +
		`${fps.toFixed(0).padStart(4)} ${pctl(gaps, 0.5).toFixed(1).padStart(6)} ${pctl(gaps, 0.9).toFixed(1).padStart(6)} ${(gaps.length ? Math.max(...gaps) : 0).toFixed(1).padStart(6)} |` +
		`${pctl(ticks, 0.5).toFixed(1).padStart(7)} ${(ticks.length ? Math.max(...ticks) : 0).toFixed(1).padStart(8)} ${pctl(jsTurns, 0.5).toFixed(1).padStart(5)} ${(jsTurns.length ? Math.max(...jsTurns) : 0).toFixed(1).padStart(6)} |` +
		`${(batches / INTERVAL).toFixed(1).padStart(8)} ${(batchOps / Math.max(1, batches)).toFixed(1).padStart(6)} ${batchMs.toFixed(0).padStart(5)} |` +
		`${heap.toFixed(0).padStart(7)} ${gcHeap.toFixed(0).padStart(6)} |` +
		`${String(c.nodes).padStart(6)} ${String(c.liveAnims).padStart(5)} ${String(c.cssAnims).padStart(4)} ${String(c.layers).padStart(6)}` +
		`  hops emit→disp=${pctl(hopEmitToDispatch, 0.5).toFixed(1)} disp→batch=${pctl(hopDispatchToBatch, 0.5).toFixed(1)}`,
	);
	hopEmitToDispatch.length = 0;
	hopDispatchToBatch.length = 0;
	hopDispatchToBatch._mark = 0;
	lastFrameDispatch = 0;
}
process.exit(0);
