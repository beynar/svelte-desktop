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
// Case 1: in-flow opaque under + absolute x-button on top
const layer1 = doc.createElement('div');
layer1.setAttribute('style', 'position:relative;width:300px;height:60px');
root.appendChild(layer1);
const underFlow = doc.createElement('div');
underFlow.setAttribute('style', 'position:absolute;top:0;left:0;width:300px;height:60px;background-color:#123456');
underFlow.addEventListener('click', () => {});
layer1.appendChild(underFlow);
const bFlow = doc.createElement('x-button' as any);
bFlow.setAttribute('style', 'position:absolute;top:0;left:0;width:100px;height:50px');
bFlow.addEventListener('click', () => {});
layer1.appendChild(bFlow);
// Case 2: absolute under + in-flow x-button that overlaps via negative margin
const layer2 = doc.createElement('div');
layer2.setAttribute('style', 'position:relative;width:300px;height:60px;top:70px');
root.appendChild(layer2);
const underAbs = doc.createElement('div');
underAbs.setAttribute('style', 'position:absolute;top:0;left:0;width:300px;height:60px;background-color:#123456');
underAbs.addEventListener('click', () => {});
layer2.appendChild(underAbs);
const bInFlow = doc.createElement('x-button' as any);
bInFlow.setAttribute('style', 'width:100px;height:50px');
bInFlow.addEventListener('click', () => {});
layer2.appendChild(bInFlow);
console.log('ids underFlow=%d bFlow=%d underAbs=%d bInFlow=%d',
	(underFlow as any).nativeId, (bFlow as any).nativeId, (underAbs as any).nativeId, (bInFlow as any).nativeId);
await pump();
for (const [name, el] of [['bFlow', bFlow], ['bInFlow', bInFlow]] as const) {
	const b = (renderer as any).getElementBounds(el.nativeId);
	console.log(name, 'bounds', JSON.stringify(b));
	renderer.drainEvents();
	renderer.simulateClick(b.x + b.width / 2, b.y + b.height / 2);
	await pump();
	console.log(name, 'click ->', JSON.stringify(renderer.drainEvents()));
}
