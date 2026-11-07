/**
 * Scroll CPU probe: the gpuix-author metric. Boots a scrollable list
 * (~200 rows), fronts the window through AX, drives simulateScrollWheel
 * continuously for a fixed window, and reports host-process CPU% —
 * cputime delta / wall. Only counts seconds where the window stayed
 * visible (occluded windows draw nothing → not the metric).
 *
 *   bun packages/tests/probe-scroll-cpu.ts
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, setViewport, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender, frameStats, scrollOffset } from '@svelte-desktop/gpuix/native';
import { spawnSync } from 'node:child_process';

installGlobals();
const renderer = new GpuixRenderer((err, payload) => {
	if (err) console.error('[gpuix]', err);
	else dispatchPayload(payload);
});
renderer.init({ title: 'scroll cpu', width: 900, height: 640 });
setRenderer(renderer);
setViewport(900, 640);

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

const rows: number[] = [];
for (let i = 0; i < 200; i++) {
	rows.push(mk('div', {
		display: 'flex', flexDirection: 'row', justifyContent: 'space-between',
		alignItems: 'center', padding: 12, flexShrink: 0, borderRadius: 10,
		backgroundColor: i % 2 ? '#2c2c2e' : '#232325',
	}, [
		mk('text', { fontSize: 14, color: '#fff' }, [], `row ${i} — the quick brown fox jumps over the lazy dog`),
		mk('text', { fontSize: 12, color: '#8e8e93' }, [], `${(i * 7) % 60}m ago`),
	]));
}
const scroller = mk('div', {
	display: 'flex', flexDirection: 'column', gap: 6, padding: 12,
	flexGrow: 1, overflowY: 'scroll', backgroundColor: '#111',
}, rows);
const rootId = next++;
ops.push(
	['createElement', rootId, 'div'],
	['setStyle', rootId, { display: 'flex', flexDirection: 'column', flexGrow: 1 }],
	['appendChild', rootId, scroller],
	['setRoot', rootId],
);
renderer.applyBatch(JSON.stringify(ops));
flush();
for (let i = 0; i < 60; i++) { renderer.tick(4); flush(); drainAfterRender(); await Bun.sleep(1); }

// front the window so it's on top — the ScrollHandle isn't clamped, so
// ping-pong inside a fixed band keeps content under the viewport.
spawnSync('swift', ['packages/tests/bin/axresize.swift', String(process.pid), 'raise']);
// float above everything — a covered window draws nothing and the
// measurement degenerates to the idle floor
renderer.platformCall(JSON.stringify({ id: 8, service: 'window', op: 'setAlwaysOnTop', args: { enabled: true } }));
for (let i = 0; i < 30; i++) { renderer.tick(4); flush(); drainAfterRender(); await Bun.sleep(1); }

const occ = () => JSON.parse(renderer.platformCall(JSON.stringify({ id: 9, service: 'window', op: 'isOccluded', args: {} }))).value === true;
const cpuTime = () => {
	const out = spawnSync('ps', ['-o', 'cputime=', '-p', String(process.pid)]).stdout.toString().trim();
	const m = out.match(/(?:(\d+):)?(\d+):([\d.]+)/);
	return (Number(m![1] ?? 0) * 60 + Number(m![2])) * 60 + Number(m![3]);
};

const SECONDS = 10;
let dir = -1, step = 0;
let wallTotal = 0, cpuTotal = 0, framesTotal = 0, deltas = 0, occludedSecs = 0;
for (let sec = 0; sec < SECONDS; sec++) {
	const f0 = frameStats().frames, c0 = cpuTime(), w0 = performance.now();
	for (let i = 0; i < 90; i++) {
		(renderer as any).simulateScrollWheel(450, 320, 0, dir * 40, null, null);
		deltas++;
		if (++step % 120 === 0) dir = -dir; // ±4800px band, inside the ~8200px content
		renderer.tick(4); flush(); drainAfterRender();
		await Bun.sleep(1);
	}
	const covered = occ();
	const df = frameStats().frames - f0, dc = cpuTime() - c0, dw = performance.now() - w0;
	console.log(`sec ${sec}: ${df} frames · cpu ${(dc / (dw / 1000) * 100).toFixed(1)}% · offset=${scrollOffset(scroller)?.[1]?.toFixed(0)} ${covered ? '· OCCLUDED (skipped)' : ''}`);
	if (!covered) { wallTotal += dw; cpuTotal += dc; framesTotal += df; } else occludedSecs++;
}
if (occludedSecs > SECONDS / 2) { console.log('window stayed occluded — measurement invalid'); process.exit(2); }
console.log(`\nVISIBLE seconds: ${(wallTotal / 1000).toFixed(1)}s wall · ${framesTotal} frames (${((framesTotal / wallTotal) * 1000).toFixed(0)}/s) · ${deltas} deltas`);
console.log(`host CPU during scroll: ${(cpuTotal / (wallTotal / 1000) * 100).toFixed(1)}% of one core`);
const stats = frameStats();
console.log(`frame p90=${stats.p90Ms?.toFixed(2)}ms p99=${stats.p99Ms?.toFixed(2)}ms max=${stats.maxMs?.toFixed(2)}ms`);
process.exit(0);
