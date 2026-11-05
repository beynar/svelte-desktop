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
const under = doc.createElement('div');
under.setAttribute('style', 'position:absolute;top:0;left:0;width:300px;height:300px;background-color:#123456');
under.addEventListener('click', () => {});
layer.appendChild(under);
const mk = (top: number, props: Record<string, unknown>) => {
	const el = doc.createElement('x-button' as any);
	for (const [k, v] of Object.entries(props)) el.setCustomProp(k, v);
	el.setAttribute('style', `position:absolute;top:${top}px;left:0;width:100px;height:50px`);
	el.addEventListener('click', () => {});
	layer.appendChild(el);
	return el;
};
const solid = mk(0, {});            // has overlay
const link = mk(60, { variant: 'link' });   // no state layer → no overlay
const disabled = mk(120, { disabled: true }); // inert → no overlay, no events
const outline = mk(180, { variant: 'outline' }); // has overlay
console.log('ids under=%d solid=%d link=%d disabled=%d outline=%d',
	(under as any).nativeId, (solid as any).nativeId, (link as any).nativeId, (disabled as any).nativeId, (outline as any).nativeId);
await pump();
for (const [name, el] of [['solid', solid], ['link', link], ['disabled', disabled], ['outline', outline]] as const) {
	const b = (renderer as any).getElementBounds(el.nativeId);
	renderer.drainEvents();
	renderer.simulateClick(b.x + b.width / 2, b.y + b.height / 2);
	await pump();
	console.log(name, '->', JSON.stringify(renderer.drainEvents()));
}
