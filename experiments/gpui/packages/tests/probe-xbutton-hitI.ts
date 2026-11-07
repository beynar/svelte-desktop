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
// button absolute top:60 — click at painted (85) AND un-offset (25)
const b = doc.createElement('x-button' as any);
b.setAttribute('style', 'position:absolute;top:60px;left:0;width:100px;height:50px');
b.addEventListener('click', () => {});
b.addEventListener('mouseEnter', () => {});
b.addEventListener('mouseLeave', () => {});
layer.appendChild(b);
// plain div absolute top:160 — control
const d = doc.createElement('div');
d.setAttribute('style', 'position:absolute;top:160px;left:0;width:100px;height:50px;background-color:#123456');
d.addEventListener('click', () => {});
layer.appendChild(d);
console.log('ids btn=%d div=%d', (b as any).nativeId, (d as any).nativeId);
await pump();
console.log('btn bounds', JSON.stringify((renderer as any).getElementBounds((b as any).nativeId)));
for (const y of [25, 85]) {
	renderer.drainEvents();
	renderer.simulateClick(50, y);
	await pump();
	console.log(`click (50,${y}):`, JSON.stringify(renderer.drainEvents()));
}
const db = (renderer as any).getElementBounds((d as any).nativeId);
renderer.drainEvents();
renderer.simulateClick(db.x + db.width / 2, db.y + db.height / 2);
await pump();
console.log('click div', JSON.stringify(db), '->', JSON.stringify(renderer.drainEvents()));
