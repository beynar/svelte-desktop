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
const mk = (top: number) => {
	const el = doc.createElement('x-button' as any);
	el.setAttribute('style', `position:absolute;top:${top}px;left:0;width:100px;height:50px`);
	el.addEventListener('click', () => {});
	el.addEventListener('mouseEnter', () => {});
	layer.appendChild(el);
	return el;
};
const b1 = mk(60), b2 = mk(120);
console.log('ids under=%d b1=%d b2=%d', (under as any).nativeId, (b1 as any).nativeId, (b2 as any).nativeId);
await pump();
for (const el of [b1, b2]) {
	const b = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(b.x + b.width / 2, b.y + b.height / 2);
	await pump();
	console.log('click on id', el.nativeId, '->', JSON.stringify(renderer.drainEvents()));
}
// mouse-move probe: does the hitbox hover?
renderer.drainEvents();
renderer.simulateMouseMove(50, 85);
await pump();
console.log('move to b1 center ->', JSON.stringify(renderer.drainEvents()));
