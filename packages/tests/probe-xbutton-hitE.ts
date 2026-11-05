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
// button at top:60 — NO under
const b = doc.createElement('x-button' as any);
b.setAttribute('style', 'position:absolute;top:60px;left:0;width:100px;height:50px');
b.addEventListener('click', () => {});
layer.appendChild(b);
// second button at top:60 WITH opaque absolute under — the failing case
const layer2 = doc.createElement('div');
layer2.setAttribute('style', 'position:relative;width:300px;height:200px;top:0');
root.appendChild(layer2);
const under2 = doc.createElement('div');
under2.setAttribute('style', 'position:absolute;top:0;left:120px;width:300px;height:200px;background-color:#123456');
under2.addEventListener('click', () => {});
layer2.appendChild(under2);
const b2 = doc.createElement('x-button' as any);
b2.setAttribute('style', 'position:absolute;top:60px;left:120px;width:100px;height:50px');
b2.addEventListener('click', () => {});
layer2.appendChild(b2);
console.log('ids b=%d under2=%d b2=%d', (b as any).nativeId, (under2 as any).nativeId, (b2 as any).nativeId);
await pump();
for (const el of [b, b2]) {
	const bb = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(bb.x + bb.width / 2, bb.y + bb.height / 2);
	await pump();
	console.log('click', el.nativeId, JSON.stringify(bb), '->', JSON.stringify(renderer.drainEvents()));
}
