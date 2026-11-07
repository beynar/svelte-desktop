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
const under = doc.createElement('div');
under.setAttribute('style', 'position:absolute;top:0;left:0;width:300px;height:200px;background-color:#123456');
under.addEventListener('mouseEnter', () => {});
under.addEventListener('mouseLeave', () => {});
layer.appendChild(under);
const b = doc.createElement('x-button' as any);
b.setAttribute('style', 'position:absolute;top:60px;left:0;width:100px;height:50px');
b.addEventListener('mouseEnter', () => {});
b.addEventListener('mouseLeave', () => {});
b.addEventListener('click', () => {});
layer.appendChild(b);
console.log('ids under=%d btn=%d', (under as any).nativeId, (b as any).nativeId);
await pump();
// sweep y — find where each element's hover toggles
for (const y of [10, 30, 50, 59, 61, 70, 85, 105, 109, 111, 130, 160]) {
	renderer.drainEvents();
	renderer.simulateMouseMove(50, y);
	await pump();
	const evs = (renderer.drainEvents() as any[]).map((e) => `${e.elementId}:${e.eventType}`);
	console.log(`y=${y}:`, evs.join(' '));
}
