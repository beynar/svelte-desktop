import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';

// install the fake DOM *before* svelte internals capture its prototype getters
installGlobals();

const renderer = new GpuixRenderer((err, payload) => {
	if (err) {
		console.error('[gpuix]', err);
		return;
	}
	// dispatchPayload routes the window-event sentinel too (keydown etc.)
	dispatchPayload(payload);
	// no flush() here — applyBatch during a native event callback reenters GpuixView
});
setRenderer(renderer);
renderer.init({ title: 'svelte → gpuix', width: 640, height: 600 });

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);

// 'svelte' resolves to its server entry under bun — bypass the exports map
const { mount } = await import('../node_modules/svelte/src/index-client.js');
const App = (await import('./gen/App.js')).default;
mount(App, { target });
flush();

if (process.env.SHOT) {
	setTimeout(() => {
		renderer.captureScreenshot('/tmp/gpuix-svelte-1.png');
		renderer.simulateClick(100, 200); // "click me" button
		setTimeout(() => {
			renderer.captureScreenshot('/tmp/gpuix-svelte-2.png');
			renderer.simulateClick(100, 470); // "add note" → remote command → sqlite
			setTimeout(() => {
				renderer.captureScreenshot('/tmp/gpuix-svelte-3.png');
				console.log('[gpuix] painted:', renderer.getPaintedText().join(' | '));
				process.exit(0);
			}, 800);
		}, 800);
	}, 2000);
}

// ~125fps pacing loop (same as @gpuix/react's startFrameLoop)
const loop = () => {
	const started = performance.now();
	const running = renderer.tick();
	flush();
	drainAfterRender(); // post-render calls (focus) need a painted frame first
	if (running === false) process.exit(0);
	setTimeout(loop, Math.max(0, 8 - (performance.now() - started)));
};
loop();
