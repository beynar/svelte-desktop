import { TestGpuixRenderer } from '@gpuix/native';

const renderer = new TestGpuixRenderer(1180, 800);

// Mount ~500 rows × 3 text cells = ~2000 elements via raw ops.
let nextId = 1_000_000;
const rootId = nextId++;
const cells: number[] = [];
const ops: unknown[] = [
	['createElement', rootId, 'div'],
	['setStyle', rootId, { display: 'flex', flexDirection: 'column', width: 400, backgroundColor: '#09090b' }],
];
for (let i = 0; i < 500; i++) {
	const r = nextId++;
	ops.push(
		['createElement', r, 'div'],
		['setStyle', r, { display: 'flex', flexDirection: 'row', gap: 8, height: 26, alignItems: 'center', paddingLeft: 8, paddingRight: 8 }],
		['appendChild', rootId, r],
	);
	for (const t of [`row ${i}`, `item ${i}`, '0']) {
		const c = nextId++;
		cells.push(c);
		ops.push(['createElement', c, 'text'], ['setText', c, t], ['setStyle', c, { fontSize: 13, color: '#fafafa' }], ['appendChild', r, c]);
	}
}
ops.push(['setRoot', rootId]);
renderer.applyBatch(JSON.stringify(ops));
renderer.flush();

console.log('mounted, elements:', renderer.getRetainedElementCount());

renderer.resetDebugFrameOverlayStats();
let tick = 0;
for (let i = 0; i < 200; i++) {
	tick++;
	// one small text mutation per frame — same as before
	renderer.applyBatch(JSON.stringify([['setText', cells[i % cells.length], `t${tick}`]]));
	renderer.flush();
}
const s = renderer.getDebugFrameOverlayStats();
console.log('with-text steady-state:', JSON.stringify(s));
