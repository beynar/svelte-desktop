import { TestGpuixRenderer } from '@gpuix/native';
const renderer = new TestGpuixRenderer(1180, 800);
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
		['setStyle', r, { display: 'flex', flexDirection: 'row', gap: 8, paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8 }],
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
renderer.resetDebugFrameOverlayStats();
let tick = 0;
for (let i = 0; i < 200; i++) {
	tick++;
	renderer.applyBatch(JSON.stringify([['setText', cells[i % cells.length], `t${tick}`]]));
	renderer.flush();
}
const s = renderer.getDebugFrameOverlayStats();
console.log('nosize steady-state:', JSON.stringify(s));
