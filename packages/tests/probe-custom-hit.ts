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
layer.setAttribute('style', 'position:relative;width:300px;height:300px');
root.appendChild(layer);
// input at top:60 (custom element, different type)
const inp = doc.createElement('input' as any);
inp.setAttribute('style', 'position:absolute;top:60px;left:0;width:100px;height:40px');
inp.addEventListener('click', () => {});
layer.appendChild(inp);
// plain div at top:120 for control
const d = doc.createElement('div');
d.setAttribute('style', 'position:absolute;top:120px;left:0;width:100px;height:40px;background-color:#123456');
d.addEventListener('click', () => {});
layer.appendChild(d);
// x-button at top:180
const b = doc.createElement('x-button' as any);
b.setAttribute('style', 'position:absolute;top:180px;left:0;width:100px;height:50px');
b.addEventListener('click', () => {});
layer.appendChild(b);
console.log('ids inp=%d div=%d btn=%d', (inp as any).nativeId, (d as any).nativeId, (b as any).nativeId);
await pump();
for (const [n, el] of [['input', inp], ['div', d], ['xbutton', b]] as const) {
	const bb = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(bb.x + bb.width / 2, bb.y + bb.height / 2);
	await pump();
	console.log(n, JSON.stringify(bb), '->', JSON.stringify(renderer.drainEvents()));
}
