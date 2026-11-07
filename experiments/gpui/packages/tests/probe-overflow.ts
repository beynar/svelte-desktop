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
layer.setAttribute('style', 'position:relative;width:300px;height:400px');
root.appendChild(layer);
// 1: plain div overflow:hidden at top:0
const dHidden = doc.createElement('div');
dHidden.setAttribute('style', 'position:absolute;top:10px;left:0;width:100px;height:40px;background-color:#123456;overflow:hidden');
dHidden.addEventListener('click', () => {});
layer.appendChild(dHidden);
// 2: x-button with overflow:visible override at top:80
const bVis = doc.createElement('x-button' as any);
bVis.setAttribute('style', 'position:absolute;top:80px;left:0;width:100px;height:50px;overflow:visible');
bVis.addEventListener('click', () => {});
layer.appendChild(bVis);
// 3: x-button default (overflow:hidden) at top:160
const bDef = doc.createElement('x-button' as any);
bDef.setAttribute('style', 'position:absolute;top:160px;left:0;width:100px;height:50px');
bDef.addEventListener('click', () => {});
layer.appendChild(bDef);
// 4: x-button default at top:240
const bDef2 = doc.createElement('x-button' as any);
bDef2.setAttribute('style', 'position:absolute;top:240px;left:0;width:100px;height:50px');
bDef2.addEventListener('click', () => {});
layer.appendChild(bDef2);
console.log('ids dHidden=%d bVis=%d bDef=%d bDef2=%d', (dHidden as any).nativeId, (bVis as any).nativeId, (bDef as any).nativeId, (bDef2 as any).nativeId);
await pump();
for (const [n, el] of [['div-overflow-hidden', dHidden], ['xbtn-overflow-visible', bVis], ['xbtn-default', bDef], ['xbtn-default2', bDef2]] as const) {
	const bb = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(bb.x + bb.width / 2, bb.y + bb.height / 2);
	await pump();
	console.log(n, JSON.stringify(bb), '->', JSON.stringify(renderer.drainEvents()));
}
