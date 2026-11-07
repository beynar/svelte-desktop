/**
 * Resize-lag probe: mount a notes-like tree on the real GpuixRenderer,
 * drive window.resize() through platformCall in a loop, and measure the
 * per-tick cost + debug frame overlay stats (p50/p99/max frame times).
 *
 * bun packages/tests/prof-resize.ts [frames]
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, setViewport, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender, frameStats } from '@svelte-desktop/gpuix/native';

const FRAMES = Number(process.argv[2] ?? 120);

installGlobals();
const renderer = new GpuixRenderer((err, payload) => {
	if (err) console.error('[gpuix]', err);
	else dispatchPayload(payload);
});
renderer.init({ title: 'resize probe', width: 900, height: 640 });
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
		mk('div', { paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, borderRadius: 8, backgroundColor: '#3a3a3c' },
			[mk('text', { fontSize: 13, color: '#fff' }, [], 'native dialog')]),
	]),
]);

const list = mk('div', { display: 'flex', flexDirection: 'column', gap: 10, padding: 16, flexGrow: 1 }, cards);
const main = mk('div', { display: 'flex', flexDirection: 'column', flexGrow: 1, backgroundColor: '#111' }, [header, list]);
const row = mk('div', { display: 'flex', flexDirection: 'row', flexGrow: 1 }, [sidebar, main]);

// raw ops build the whole tree — rootId wraps the row as the window root
const rootId = next++;
ops.push(['createElement', rootId, 'div'], ['setStyle', rootId, { display: 'flex', flexDirection: 'column', flexGrow: 1 }], ['appendChild', rootId, row], ['setRoot', rootId]);
renderer.applyBatch(JSON.stringify(ops));
flush();

// a few warm ticks so the first frame's cost doesn't pollute the stats
for (let i = 0; i < 10; i++) { renderer.tick(); flush(); drainAfterRender(); }

renderer.resetDebugFrameOverlayStats?.();
const tickMs: number[] = [];
for (let i = 0; i < FRAMES; i++) {
	const w = 900 + (i % 2) * 320 + (i % 3) * 60;
	const h = 640 + (i % 2) * 220;
	renderer.platformCall(JSON.stringify({ id: i, service: 'window', op: 'setSize', args: { width: w, height: h } }));
	const t = performance.now();
	renderer.tick();
	flush();
	drainAfterRender();
	tickMs.push(performance.now() - t);
}
tickMs.sort((a, b) => a - b);
const q = (p: number) => tickMs[Math.min(tickMs.length - 1, Math.floor(tickMs.length * p))].toFixed(1);
console.log(`ticks=${tickMs.length} p50=${q(0.5)}ms p90=${q(0.9)}ms p99=${q(0.99)}ms max=${tickMs.at(-1)?.toFixed(1)}ms`);
console.log('frameStats:', JSON.stringify(frameStats()));
process.exit(0);
