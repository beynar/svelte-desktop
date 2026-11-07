import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';

installGlobals();

const renderer = new GpuixRenderer((err, payload) => {
	if (err) {
		console.error('[gpuix]', err);
		return;
	}
	dispatchPayload(payload);
});
setRenderer(renderer);
renderer.init({ title: 'svelai tokens → gpuix (no css engine)', width: 1180, height: 780 });
renderer.setDebugFrameOverlay('full');
setViewport(1180, 780);

// note: NO theme.css — the kit resolves tokens to StyleDesc directly
const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:1180px;height:780px');
doc.body.appendChild(target);
materializeRoot(target);

const { mount } = await import('../node_modules/svelte/src/index-client.js');
const KitDemo = (await import('./gen/nkit/KitDemo.js')).default;
mount(KitDemo, { target });
flush();

if (process.env.SHOT) {
	setTimeout(() => {
		renderer.captureScreenshot('/tmp/kit-1.png');
		console.log('[gpuix] painted:', renderer.getPaintedText().join(' | ').slice(0, 3000));
		process.exit(0);
	}, 3000);
}

const loop = () => {
	const started = performance.now();
	const running = renderer.tick();
	flush();
	drainAfterRender();
	if (running === false) process.exit(0);
	setTimeout(loop, Math.max(0, 8 - (performance.now() - started)));
};
loop();
