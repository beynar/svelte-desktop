import { TestGpuixRenderer } from '@gpuix/native';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';
import { installGlobals, doc, materializeRoot, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
installGlobals();
const renderer = new TestGpuixRenderer(400, 400);
setRenderer(renderer);
const events: string[] = [];
const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:400px;height:400px;backgroundColor:#111');
doc.body.appendChild(target);
materializeRoot(target);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function pump(times = 1) {
	for (let i = 0; i < times; i++) {
		for (const ev of renderer.drainEvents()) dispatchPayload(ev);
		await sleep(30);
		flush();
		renderer.flush();
		drainAfterRender();
	}
}
for (let i = 0; i < 10; i++) {
	const row = doc.createElement('div');
	row.setAttribute('style', `height:40px;background:#222;display:flex;alignItems:center;paddingLeft:8px`);
	const label = doc.createElement('div');
	label.setAttribute('style', 'fontSize:12px;color:#fff');
	label.appendChild(doc.createTextNode(`row ${i}`));
	row.appendChild(label);
	const setIdle = () => row.setAttribute('style', `height:40px;background:#222;display:flex;alignItems:center;paddingLeft:8px`);
	const setHot = () => row.setAttribute('style', `height:40px;background:#f00;display:flex;alignItems:center;paddingLeft:8px`);
	row.addEventListener('mouseover', () => { events.push(`enter ${i}`); setHot(); });
	row.addEventListener('mouseout', () => { events.push(`leave ${i}`); setIdle(); });
	target.appendChild(row);
}
await pump(3);
console.log('--- slow pass: row2 -> row3 ---');
renderer.simulateMouseMove(50, 90);
await pump();
renderer.simulateMouseMove(50, 140);
await pump();
console.log('--- fast pass: row3 -> row8 (skips 4-7) ---');
renderer.simulateMouseMove(50, 330);
await pump();
console.log('--- to empty corner ---');
renderer.simulateMouseMove(395, 395);
await pump();
console.log('events:', events.join(' | '));
const styles = (target.childNodes as any[]).map((n, i) => `${i}:${n.getAttribute?.('style')?.match(/#f00|#222/)?.[0]}`).join(' ');
console.log('final bgs:', styles);
process.exit(0);
