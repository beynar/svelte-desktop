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
const d1 = doc.createElement('div'); // focusable div, absolute top:60
d1.setAttribute('style', 'position:absolute;top:60px;left:0;width:100px;height:50px;background-color:#123456');
d1.setAttribute('tabindex', '0');
d1.addEventListener('click', () => {});
layer.appendChild(d1);
const b = doc.createElement('x-button' as any); // x-button, absolute top:130
b.setAttribute('style', 'position:absolute;top:130px;left:0;width:100px;height:50px');
b.addEventListener('click', () => {});
layer.appendChild(b);
console.log('ids divFocus=%d btn=%d', (d1 as any).nativeId, (b as any).nativeId);
await pump();
for (const [n, el] of [['focusable-div', d1], ['xbutton', b]] as const) {
	const bb = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(bb.x + bb.width / 2, bb.y + bb.height / 2);
	await pump();
	console.log(n, JSON.stringify(bb), '->', JSON.stringify(renderer.drainEvents()));
}
