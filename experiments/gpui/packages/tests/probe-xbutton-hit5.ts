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
// Case A: absolute x-button + click listener, NO underlap
const bA = doc.createElement('x-button' as any);
bA.setAttribute('style', 'position:absolute;top:0;left:0;width:100px;height:50px');
bA.addEventListener('click', () => {});
root.appendChild(bA);
// Case B: absolute plain div + click listener over an under div
const layerB = doc.createElement('div');
layerB.setAttribute('style', 'position:relative;width:300px;height:60px;top:60px');
root.appendChild(layerB);
const underB = doc.createElement('div');
underB.setAttribute('style', 'position:absolute;top:0;left:0;width:300px;height:60px;background-color:#123456');
underB.addEventListener('click', () => {});
layerB.appendChild(underB);
const divB = doc.createElement('div');
divB.setAttribute('style', 'position:absolute;top:0;left:0;width:100px;height:50px;background-color:#654321');
divB.addEventListener('click', () => {});
layerB.appendChild(divB);
// Case C: absolute x-button + click listener over under
const layerC = doc.createElement('div');
layerC.setAttribute('style', 'position:relative;width:300px;height:60px;top:130px');
root.appendChild(layerC);
const underC = doc.createElement('div');
underC.setAttribute('style', 'position:absolute;top:0;left:0;width:300px;height:60px;background-color:#123456');
underC.addEventListener('click', () => {});
layerC.appendChild(underC);
const bC = doc.createElement('x-button' as any);
bC.setAttribute('style', 'position:absolute;top:0;left:0;width:100px;height:50px');
bC.addEventListener('click', () => {});
layerC.appendChild(bC);
console.log('ids bA=%d underB=%d divB=%d underC=%d bC=%d',
	(bA as any).nativeId, (underB as any).nativeId, (divB as any).nativeId, (underC as any).nativeId, (bC as any).nativeId);
await pump();
for (const [name, el] of [['bA', bA], ['divB', divB], ['bC', bC]] as const) {
	const b = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(b.x + b.width / 2, b.y + b.height / 2);
	await pump();
	console.log(name, '->', JSON.stringify(renderer.drainEvents()));
}
