/**
 * Live-app diagnostic v2 — boots host.js (real app + real window in THIS
 * process), activates itself so the window is frontmost/visible (display
 * link runs — the occluded-window fallback otherwise distorts cadence),
 * navigates to /animations, then measures wheel→frame latency end-to-end.
 *
 * Run: cd app && bun ../packages/vite/runtime/probe-live.js
 *   (env: SVELTE_NATIVE_ROOT, SVELTE_NATIVE_DEVJSON — or defaults below)
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

// raise ourselves so the window is frontmost → occlusion visible → link runs.
// NSRunningApplication.activate alone doesn't front a bare bun process —
// AXRaise on the AXWindow does. Must wait for init() to have created the
// window (it opens during module eval, racing our wait loop).
await sleep(800);
// RAISE=1 to front the window (display-link path); default stays occluded to
// exercise the fallback path.
if (process.env.RAISE === '1') {
	try { execSync(`swift /tmp/axraise.swift ${process.pid}`); } catch {}
}

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
// loop period = tick→tick delta; JS turn = period − tick duration
const periods = [];
const jsTurns = [];
let lastTickAt = -1;
const origApply = renderer.applyBatch.bind(renderer);
let batchMs = 0, batchOps = 0, batches = 0;
renderer.applyBatch = (json) => {
	const t = now();
	const r = origApply(json);
	batchMs += now() - t;
	batchOps += JSON.parse(json).length;
	batches++;
	return r;
};
const sampleTurns = () => {
	periods.length = 0; jsTurns.length = 0;
	for (let i = 1; i < tickAt.length; i++) {
		const p = tickAt[i] - tickAt[i - 1];
		periods.push(p);
		jsTurns.push(p - ticks[i - 1]);
	}
	batchMs = 0; batchOps = 0; batches = 0;
};
const stats = (a) => {
	if (!a.length) return 'n=0';
	const s = [...a].sort((x, y) => x - y);
	const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
	return `n=${a.length} p50=${q(0.5)} p90=${q(0.9)} max=${s[s.length - 1].toFixed(1)}`;
};

await sleep(1200);
// link check: while idle, tick() blocks the full budget; with the link
// running each vsync dispatch ends the wait early → p50 ~5-10ms.
{
	ticks.length = 0;
	await sleep(500);
	console.log(`tick idle (link probe): ${stats(ticks)}`);
}

// ── nav → first frame ────────────────────────────────────────────────
const navMark = frames.length;
const navT0 = now();
await host.router.goto('/animations');
while (frames.length === navMark && now() - navT0 < 5000) await sleep(1);
console.log(`nav→first frame: ${(frames[navMark] - navT0 || -1).toFixed(1)}ms`);

await sleep(1500); // intros settle
{
	const f0 = frames.length;
	tickAt.length = 0; ticks.length = 0;
	await sleep(1500);
	console.log(`steady frame rate: ${((frames.length - f0) / 1.5).toFixed(0)}/s`);
	sampleTurns();
	console.log(`  loop period: ${stats(periods)}`);
	console.log(`  JS turn (period−tick): ${stats(jsTurns)}`);
	console.log(`  tick: ${stats(ticks)}`);
	await sleep(300);
	console.log(`  applyBatch: n=${batches} total=${batchMs.toFixed(1)}ms ops=${batchOps} (${(batchOps / Math.max(1, batches)).toFixed(1)}/batch)`);
}

// ── renderer frame duration (overlay stats) ──────────────────────────
try {
	renderer.setDebugFrameOverlay('hidden');
	renderer.resetDebugFrameOverlayStats();
	await sleep(2000);
	console.log(`  overlay: ${JSON.stringify(renderer.getDebugFrameOverlayStats())}`);
	renderer.setDebugFrameOverlay('off');
} catch (e) {
	console.log('  overlay stats:', e.message);
}

// ── scroll latency: inject → frame ───────────────────────────────────
ticks.length = 0; tickAt.length = 0;
const injects = [];
const t0 = now();
for (let i = 0; i < 80; i++) {
	injects.push(now());
	renderer.simulateScrollWheel(600, 400, 0, -30, null, null);
	await sleep(12);
}
const scrollMs = now() - t0;
const sf = frames.filter((t) => t >= t0);
const lat = injects.map((t) => sf.find((ft) => ft >= t) - t);
console.log(`scroll: 80 ticks/${scrollMs.toFixed(0)}ms → frames ${sf.length} · inject→frame ${stats(lat)}`);
console.log(`tick during scroll: ${stats(ticks)}`);
// inter-frame gaps during scroll — the judder signature
const sg = sf.slice(1).map((t, i) => t - sf[i]);
console.log(`frame gaps during scroll: ${stats(sg)}`);

// capture the scene — is it scrolled?
try { renderer.captureScreenshot('/tmp/motion-scrolled.png'); } catch (e) { console.log('capture:', e.message); }
process.exit(0);
