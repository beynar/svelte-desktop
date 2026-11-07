import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchNative, domEvent, materializeRoot } from './gdom';
import { setRenderer, nodeForNativeId, flush, drainAfterRender } from './native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const { mount } = await import('../node_modules/svelte/src/index-client.js');
const App2 = (await import('./gen/App2.js')).default;
mount(App2, { target });
flush();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async () => {
	const evs = renderer.drainEvents();
	if (evs.length) console.log('raw evs:', JSON.stringify(evs));
	for (const ev of evs) {
		const node = nodeForNativeId(ev.elementId) as any;
		if (node) dispatchNative(node, domEvent(ev.eventType), ev);
	}
	await sleep(50);
	flush();
	renderer.flush();
	drainAfterRender();
	renderer.flush();
};
await sleep(100);
renderer.flush(); drainAfterRender();
renderer.flush();
renderer.captureScreenshot('/tmp/gpuix-u1.png');
console.log('tree:', renderer.getAutomationTree().slice(0, 1500));
console.log('--- typing "hi gpuix" ---');
renderer.simulateKeystrokes('hello');
await pump();
renderer.captureScreenshot('/tmp/gpuix-u2.png');
console.log('painted:', renderer.getPaintedText().join(' | '));
renderer.simulateClick(100, 300);
await pump();
console.log('painted:', renderer.getPaintedText().join(' | '));
process.exit(0);
