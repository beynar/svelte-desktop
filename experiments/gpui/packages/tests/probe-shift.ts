import { TestGpuixRenderer } from '@gpuix/native';
import { setRenderer, flush, drainAfterRender, listScrollTop } from '@svelte-desktop/gpuix/native';
import { installGlobals, doc, materializeRoot, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
installGlobals();
const W = 400, H = 500;
const renderer = new TestGpuixRenderer(W, H);
setRenderer(renderer);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function pump(times = 1) {
	for (let i = 0; i < times; i++) {
		for (const ev of renderer.drainEvents()) dispatchPayload(ev);
		await sleep(20);
		flush();
		renderer.flush();
		drainAfterRender();
	}
}
const target = doc.createElement('div');
target.setAttribute('style', `display:flex;flex-direction:column;width:${W}px;height:${H}px;backgroundColor:#111`);
doc.body.appendChild(target);
materializeRoot(target);
const COUNT = 500, ROW_H = 46, OVERDRAW = 8;
const vl = doc.createElement('virtual-list');
vl.setAttribute('style', 'flex-grow:1');
vl.setCustomProp('itemCount', COUNT);
vl.setCustomProp('estimatedItemHeight', ROW_H);
vl.setCustomProp('windowStart', 0);
target.appendChild(vl);
const btnStyle = (bg: string) =>
	'display:flex;flex-direction:row;align-items:center;gap:10px;' +
	'padding:10px 14px;border-radius:8px;background-color:' + bg + ';' +
	'border-width:1px;border-color:#27272a;flex-shrink:0;height:' + (ROW_H - 6) + 'px;margin:3px 12px';
function makeRow(i: number) {
	const btn = doc.createElement('div');
	btn.setAttribute('style', btnStyle('#1f1f23'));
	const label = doc.createElement('div');
	label.setAttribute('style', 'color:#e4e4e7;font-size:13px');
	label.appendChild(doc.createTextNode(`Button #${i}`));
	const badge = doc.createElement('div');
	badge.setAttribute('style', 'color:#71717a;font-size:11px;margin-left:auto');
	badge.appendChild(doc.createTextNode('0 clicks'));
	btn.appendChild(label);
	btn.appendChild(badge);
	btn.addEventListener('mouseover', () => btn.setAttribute('style', btnStyle('#2e2e35')));
	btn.addEventListener('mouseout', () => btn.setAttribute('style', btnStyle('#1f1f23')));
	return btn;
}
let windowStart = -1;
function renderWindow(start: number) {
	const visible = Math.ceil(H / ROW_H) + 2 * OVERDRAW;
	const end = Math.min(COUNT, start + visible);
	while (vl.firstChild) vl.removeChild(vl.firstChild);
	for (let i = start; i < end; i++) vl.appendChild(makeRow(i));
	windowStart = start;
	vl.setCustomProp('windowStart', start);
}
function syncRange() {
	if (!vl.nativeId) return;
	const anchor = listScrollTop(vl.nativeId);
	if (!anchor) return;
	const start = Math.max(0, Math.min(COUNT - 1, anchor[0] - OVERDRAW));
	if (start !== windowStart) renderWindow(start);
}
vl.addEventListener('visiblerange', syncRange);
vl.addEventListener('scroll', syncRange);
renderWindow(0);
await pump(5);
const rowsBounds = () => {
	const t = JSON.parse(renderer.getAutomationTree() as any);
	const out: any[] = [];
	const walk = (n: any) => {
		if (n.bounds && (n.type === 'div' || n.type === 'virtual-row')) out.push(n.bounds);
		(n.children ?? []).forEach(walk);
	};
	walk(t);
	return out;
};
const before = rowsBounds();
console.log('BEFORE:', before.slice(0, 6).map(b => `${b.x},${b.y} ${b.width}x${b.height}`).join(' | '));
renderer.simulateMouseMove(50, 3 * ROW_H + 20);
await pump(1);
const during1 = rowsBounds();
console.log('HOVER+1:', during1.slice(0, 6).map(b => `${b.x},${b.y} ${b.width}x${b.height}`).join(' | '));
await pump(3);
const during3 = rowsBounds();
console.log('HOVER+4:', during3.slice(0, 6).map(b => `${b.x},${b.y} ${b.width}x${b.height}`).join(' | '));
renderer.simulateMouseMove(50, 490);
await pump(3);
const after = rowsBounds();
console.log('AFTER :', after.slice(0, 6).map(b => `${b.x},${b.y} ${b.width}x${b.height}`).join(' | '));
for (const [name, a, b] of [['h+1 vs before', before, during1], ['h+4 vs h+1', during1, during3], ['after vs h+4', during3, after]] as const) {
	let diffs = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++)
		if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) diffs++;
	console.log(`${name}: ${diffs} bounds differ (${a.length} vs ${b.length} nodes)`);
}


// scroll then hover — recycled rows under cursor
console.log('--- scroll 300px ---');
renderer.simulateScrollWheel(50, 300, 0, 300);
await pump(4);
console.log('anchor:', JSON.stringify(vl.nativeId ? listScrollTop(vl.nativeId) : null));
const s1 = rowsBounds();
console.log('S+   :', s1.slice(0, 6).map(b => `${b.x},${b.y} ${b.width}x${b.height}`).join(' | '));
renderer.simulateMouseMove(50, 100);
await pump(1);
const s2 = rowsBounds();
console.log('S+H+1:', s2.slice(0, 6).map(b => `${b.x},${b.y} ${b.width}x${b.height}`).join(' | '));
await pump(3);
const s3 = rowsBounds();
console.log('S+H+4:', s3.slice(0, 6).map(b => `${b.x},${b.y} ${b.width}x${b.height}`).join(' | '));
let d = 0;
for (let i = 0; i < Math.min(s1.length, s3.length); i++) if (JSON.stringify(s1[i]) !== JSON.stringify(s3[i])) d++;
console.log(`scroll vs scroll+hover+4: ${d} bounds differ (${s1.length} vs ${s3.length})`);

