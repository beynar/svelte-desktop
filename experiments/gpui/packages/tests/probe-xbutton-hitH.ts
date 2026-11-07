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
const mk = (top: number, flow = false) => {
	const el = doc.createElement('x-button' as any);
	el.setAttribute('style', flow ? `width:100px;height:50px;margin-top:${top}px` : `position:absolute;top:${top}px;left:0;width:100px;height:50px`);
	el.addEventListener('click', () => {});
	layer.appendChild(el);
	return el;
};
const t0 = mk(0), t60 = mk(60), t120 = mk(120), flow = mk(170, true);
await pump();
for (const el of [t0, t60, t120, flow]) {
	const bb = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(bb.x + bb.width / 2, bb.y + bb.height / 2);
	await pump();
	console.log('click', el.nativeId, JSON.stringify(bb), '->', JSON.stringify(renderer.drainEvents()));
}
