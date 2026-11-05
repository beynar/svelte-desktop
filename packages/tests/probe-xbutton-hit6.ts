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
under.addEventListener('click', () => {});
layer.appendChild(under);
// b1: click only; b2: click + mouseEnter
const b1 = doc.createElement('x-button' as any);
b1.setAttribute('style', 'position:absolute;top:60px;left:0;width:100px;height:50px');
b1.addEventListener('click', () => {});
layer.appendChild(b1);
const b2 = doc.createElement('x-button' as any);
b2.setAttribute('style', 'position:absolute;top:120px;left:0;width:100px;height:50px');
b2.addEventListener('click', () => {});
b2.addEventListener('mouseEnter', () => {});
layer.appendChild(b2);
console.log('ids under=%d b1=%d b2=%d', (under as any).nativeId, (b1 as any).nativeId, (b2 as any).nativeId);
await pump();
for (const el of [b1, b2]) {
	const b = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(b.x + b.width / 2, b.y + b.height / 2);
	await pump();
	console.log('click on', el.nativeId, '->', JSON.stringify(renderer.drainEvents()));
}
