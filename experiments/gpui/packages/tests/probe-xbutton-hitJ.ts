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
const b = doc.createElement('x-button' as any);
b.setAttribute('style', 'position:absolute;top:60px;left:0;width:100px;height:50px');
b.addEventListener('click', () => {});
b.addEventListener('mouseEnter', () => {});
layer.appendChild(b);
console.log('btn id=%d', (b as any).nativeId);
await pump();
// pre-focus via keyboard so click doesn't steal focus
renderer.focusNext();
await pump();
console.log('focused:', await (renderer as any).getFocusedElementId?.());
// now raw down/up separately
renderer.drainEvents();
renderer.simulateMouseDown(50, 85);
await pump();
console.log('after down:', JSON.stringify(renderer.drainEvents()));
renderer.simulateMouseUp(50, 85);
await pump();
console.log('after up:', JSON.stringify(renderer.drainEvents()));
// and click again (already focused)
renderer.drainEvents();
renderer.simulateClick(50, 85);
await pump();
console.log('click again:', JSON.stringify(renderer.drainEvents()));
