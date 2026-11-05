/**
 * Headless E2E: Svelte app → fake DOM → gpuix mutations → offscreen GPU render,
 * with input simulated through GPUI's real hit-testing pipeline.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchNative, domEvent, materializeRoot } from './gdom';
import { setRenderer, nodeForNativeId, flush } from './native';

installGlobals();

const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as unknown as import('@gpuix/native').GpuixRenderer);

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);

const { mount } = await import('../node_modules/svelte/src/index-client.js');
const App = (await import('./gen/App.js')).default;
mount(App, { target });
flush();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async () => {
	for (const ev of renderer.drainEvents()) {
		const node = nodeForNativeId(ev.elementId) as Parameters<typeof dispatchNative>[0] | undefined;
		if (node) dispatchNative(node, domEvent(ev.eventType), ev as Record<string, unknown>);
	}
	await sleep(50); // let svelte's effect flush + our op flush land
	flush();
	renderer.flush();
};

await sleep(100);
renderer.flush();
renderer.captureScreenshot('/tmp/gpuix-t1.png');
console.log('=== painted:', renderer.getPaintedText().join(' | '));

console.log('--- click counter button ---');
renderer.simulateClick(100, 200);
await pump();
renderer.captureScreenshot('/tmp/gpuix-t2.png');
console.log('=== painted:', renderer.getPaintedText().join(' | '));

console.log('--- click add-note (remote command → bun:sqlite) ---');
renderer.simulateClick(100, 470);
await pump();
renderer.captureScreenshot('/tmp/gpuix-t3.png');
console.log('=== painted:', renderer.getPaintedText().join(' | '));

console.log('--- click counter again ---');
renderer.simulateClick(100, 200);
await pump();
console.log('=== painted:', renderer.getPaintedText().join(' | '));
console.log('retained elements:', renderer.getRetainedElementCount());
process.exit(0);
