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
layer.setAttribute('style', 'position:relative;width:400px;height:400px');
root.appendChild(layer);
const cases: [string, string][] = [
	['abs-left60', 'position:absolute;top:0;left:60px;width:100px;height:50px'],
	['abs-top60-left60', 'position:absolute;top:120px;left:60px;width:100px;height:50px'],
	['fixed-top200', 'position:fixed;top:200px;left:0;width:100px;height:50px'],
	['rel-top260', 'position:relative;top:260px;left:0;width:100px;height:50px'],
];
const els = cases.map(([name, style]) => {
	const el = doc.createElement('x-button' as any);
	el.setAttribute('style', style);
	el.addEventListener('click', () => {});
	layer.appendChild(el);
	return [name, el] as const;
});
await pump();
for (const [n, el] of els) {
	const bb = (renderer as any).getElementBounds((el as any).nativeId);
	renderer.drainEvents();
	renderer.simulateClick(bb.x + bb.width / 2, bb.y + bb.height / 2);
	await pump();
	console.log(n, JSON.stringify(bb), '->', JSON.stringify(renderer.drainEvents()));
}
