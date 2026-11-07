import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';
installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async () => { flush(); renderer.flush(); await sleep(30); };
const root = doc.createElement('div');
doc.body.appendChild(root);
materializeRoot(root);
const layer = doc.createElement('div');
layer.setAttribute('style', 'position:relative;width:300px;height:200px');
root.appendChild(layer);
const b = doc.createElement('x-button' as any);
b.setAttribute('style', 'position:absolute;top:60px;left:0;width:100px;height:50px');
b.addEventListener('click', () => {});
b.addEventListener('mouseEnter', () => {});
b.addEventListener('mouseLeave', () => {});
layer.appendChild(b);
console.log('btn id=%d bounds=%s', (b as any).nativeId, JSON.stringify((renderer as any).getElementBounds((b as any).nativeId)));
await pump();
// probe clicks across the whole column to find the real hit region
for (const y of [10, 30, 70, 85, 110, 140, 170]) {
	renderer.drainEvents();
	renderer.simulateClick(50, y);
	await pump();
	console.log(`click y=${y}:`, JSON.stringify(renderer.drainEvents()));
}
// and hover sweep
for (const y of [10, 30, 70, 85, 140, 170]) {
	renderer.drainEvents();
	renderer.simulateMouseMove(50, y);
	await pump();
	const evs = (renderer.drainEvents() as any[]).map((e) => `${e.elementId}:${e.eventType}`);
	console.log(`move y=${y}:`, evs.join(' '));
}
