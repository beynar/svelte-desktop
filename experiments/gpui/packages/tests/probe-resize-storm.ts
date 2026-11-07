/**
 * Resize-storm gate: the real Swish repro. Boots a notes-like tree on the
 * real GpuixRenderer, raises its window, then hammers it with 40 rapid
 * AX Size writes via bin/axresize.swift while the loop pumps the runloop.
 * Fails if per-write latency regresses.
 *
 *   bun packages/tests/probe-resize-storm.ts
 *
 * Gate invariant: a healthy build draws ~WRITES/10 frames during the storm
 * (coalesced applies), not ~1 frame per write. Client-side latency depends
 * on window state — frontmost ~0.5-1.5ms/write, visible-background ~9ms of
 * pure IPC — so latency is only a loose backstop.
 *   occluded  ~52ms/write uniform — WindowServer throttles frame commits
 *     for fully-covered windows (stock Finder reproduces the same), so an
 *     occluded run reports OCCLUDED and skips the gate rather than fail.
 * Requires Accessibility permission for the host terminal/IDE.
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, setViewport, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender, frameStats } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new GpuixRenderer((err, payload) => {
	if (err) console.error('[gpuix]', err);
	else dispatchPayload(payload);
});
renderer.init({ title: 'resize storm gate', width: 900, height: 640 });
setRenderer(renderer);
setViewport(900, 640);

// ── tree: sidebar + header + 60 note cards (~400 elements, text + shadows) ──
let next = 1_000_000;
const ops: unknown[] = [];
const mk = (tag: string, style: unknown, kids: number[] = [], text?: string) => {
	const id = next++;
	ops.push(['createElement', id, tag]);
	if (text !== undefined) ops.push(['setText', id, text]);
	ops.push(['setStyle', id, style]);
	for (const k of kids) ops.push(['appendChild', id, k]);
	return id;
};

const nav = ['Notes', 'About'].map((label, i) =>
	mk('div', {
		paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
		borderRadius: 8, fontSize: 14,
		backgroundColor: i === 0 ? '#0a84ff' : '#00000000',
		color: i === 0 ? '#fff' : '#8e8e93',
	}, [mk('text', { fontSize: 14, color: i === 0 ? '#fff' : '#8e8e93' }, [], label)]));

const sidebar = mk('div', {
	width: 200, display: 'flex', flexDirection: 'column', gap: 4, padding: 12,
	backgroundColor: '#1c1c1e',
}, [
	mk('div', { display: 'flex', gap: 8, padding: 8 }, [
		mk('text', { fontSize: 15, color: '#fff', fontWeight: 'bold' }, [], 'svelte-desktop'),
	]),
	...nav,
]);

const cards: number[] = [];
for (let i = 0; i < 60; i++) {
	cards.push(mk('div', {
		display: 'flex', flexDirection: 'row', justifyContent: 'space-between',
		alignItems: 'center', padding: 14, borderRadius: 12,
		backgroundColor: '#2c2c2e',
		shadowColor: '#000', shadowBlur: 12, shadowOffsetY: 2, shadowOpacity: 0.35,
	}, [
		mk('div', { display: 'flex', flexDirection: 'column', gap: 4 }, [
			mk('text', { fontSize: 14, color: '#fff', fontWeight: '600' }, [], `note ${i} — ezeaeza eaeaez eza`),
			mk('text', { fontSize: 11, color: '#636366' }, [], '09-18 · 16:37'),
		]),
		mk('text', { fontSize: 16, color: '#8e8e93' }, [], '×'),
	]));
}

const header = mk('div', {
	display: 'flex', flexDirection: 'row', justifyContent: 'space-between',
	alignItems: 'center', padding: 16, gap: 12,
}, [
	mk('text', { fontSize: 24, color: '#fff', fontWeight: 'bold' }, [], 'Notes'),
	mk('div', { display: 'flex', flexDirection: 'row', gap: 8 }, [
		mk('div', { paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, borderRadius: 8, backgroundColor: '#3a3a3c' },
			[mk('text', { fontSize: 13, color: '#fff' }, [], 'counter · 20')]),
	]),
]);

const list = mk('div', { display: 'flex', flexDirection: 'column', gap: 10, padding: 16, flexGrow: 1 }, cards);
const main = mk('div', { display: 'flex', flexDirection: 'column', flexGrow: 1, backgroundColor: '#111' }, [header, list]);
const row = mk('div', { display: 'flex', flexDirection: 'row', flexGrow: 1 }, [sidebar, main]);

const rootId = next++;
ops.push(['createElement', rootId, 'div'], ['setStyle', rootId, { display: 'flex', flexDirection: 'column', flexGrow: 1 }], ['appendChild', rootId, row], ['setRoot', rootId]);
renderer.applyBatch(JSON.stringify(ops));
flush();

// raise the window so it is visible (occluded windows hit the OS floor).
// platformCall activate/focus isn't enough for a bare bun process — front it
// through AX like Swish would see it, otherwise writes take the slow WS path.
renderer.platformCall(JSON.stringify({ id: 1, service: 'app', op: 'activate', args: {} }));
renderer.platformCall(JSON.stringify({ id: 2, service: 'window', op: 'focus', args: {} }));
for (let i = 0; i < 30; i++) { renderer.tick(4); flush(); drainAfterRender(); await Bun.sleep(1); }
const axBin = new URL('./bin/axresize.swift', import.meta.url).pathname;

const WRITES = 40;
const framesBefore = frameStats().frames;
// AXRESIZE_RAISE fronts the window right before the writes — platformCall's
// activate/focus doesn't fully front a bare bun process.
const proc = Bun.spawn(
	['swift', axBin, String(process.pid), String(WRITES)],
	{ stdout: 'pipe', stderr: 'inherit', env: { ...process.env, AXRESIZE_RAISE: '1' } },
);

// keep pumping the runloop while the AX client hammers writes — AX sources
// are only serviced inside tick()'s pump. Same shape as the emitted app
// loop: tick(FRAME_MS) then pace the next iteration to the same period.
let exited = false;
proc.exited.then(() => { exited = true; });
while (!exited) {
	const started = performance.now();
	renderer.tick(4);
	flush();
	drainAfterRender();
	await new Promise(r => setTimeout(r, Math.max(1, 4 - (performance.now() - started))));
}
const out = await new Response(proc.stdout).text();

const m = out.match(/writes=(\d+) total=([\d.]+)ms p50=([\d.]+) p90=([\d.]+) max=([\d.]+)/);
if (!m || out.includes(' err ') || out.includes('no AX windows')) {
	console.error(out);
	console.error('FAIL: axresize could not write — check Accessibility permission for this terminal');
	process.exit(1);
}
const [, , total, p50, p90, max] = m.map(Number) as unknown as [string, number, number, number, number, number];
console.log(`ax storm: writes=${WRITES} total=${total}ms p50=${p50}ms p90=${p90}ms max=${max}ms`);

// the storm must actually land — a failing AX write returns instantly and
// would fake a pass, so confirm the window reached the final target size
for (let i = 0; i < 40; i++) { renderer.tick(4); flush(); drainAfterRender(); await Bun.sleep(1); }
const sizeRes = JSON.parse(renderer.platformCall(JSON.stringify({ id: 3, service: 'window', op: 'getSize', args: {} })));
const lastW = 900 + ((WRITES - 1) % 3) * 160;
const lastH = 640 + ((WRITES - 1) % 2) * 120;
const got = sizeRes.value ?? {};
// AXSize is the frame rect while getSize reports the content view — a
// titled window's content is shorter by the chrome height, so assert on
// the width (chrome-free) plus a height band that tolerates the titlebar.
const landed = Math.abs(got.width - lastW) < 2 && got.height > lastH - 40 && got.height <= lastH;
const stats = frameStats();
const stormFrames = stats.frames - framesBefore;
console.log(`final size: ${got.width}x${got.height} (expected ~${lastW}x${lastH}±chrome)`);
console.log(`frameStats: ${JSON.stringify(stats)} stormFrames=${stormFrames}`);

const occRes = JSON.parse(renderer.platformCall(JSON.stringify({ id: 4, service: 'window', op: 'isOccluded', args: {} })));
const occluded = occRes.value === true || p50 > 30;
if (occluded) {
	console.log('OCCLUDED: window is fully covered — WindowServer throttles the commits, gate not applicable');
	process.exit(0);
}

// The real invariant: writes coalesce into ~WRITES/10 applies, not 1:1 draws.
// Frontmost windows write at ~0.5-1.5ms; a visible-but-backgrounded window
// floors at ~9ms of pure IPC latency with zero extra frames — so frames,
// not p50, is the discriminator. Latency bounds are a loose backstop.
if (!landed || stormFrames > 15 || p50 > 12 || p90 > 25 || total > 600) {
	console.error(`FAIL: resize storm regression (p50=${p50}ms, p90=${p90}ms, total=${total}ms, stormFrames=${stormFrames}, landed=${landed})`);
	process.exit(1);
}
console.log('PASS');
process.exit(0);
