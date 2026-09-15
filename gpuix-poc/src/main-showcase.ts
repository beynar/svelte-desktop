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
const W = 1280, H = 800;
renderer.init({ title: 'nkit showcase — svelai on gpuix', width: W, height: H });
renderer.setDebugFrameOverlay('minimal');
setViewport(W, H);

// no theme.css — kit resolves style props straight to StyleDesc
const target = doc.createElement('div');
target.setAttribute('style', `display:flex;flex-direction:column;width:${W}px;height:${H}px`);
doc.body.appendChild(target);
materializeRoot(target);

const { mount } = await import('../node_modules/svelte/src/index-client.js');
const Showcase = (await import('./gen/nkit/showcase/Showcase.js')).default;
mount(Showcase, { target });
flush();

if (process.env.SHOT) {
	setTimeout(() => {
		renderer.captureScreenshot(process.env.SHOT_FILE ?? '/tmp/showcase.png');
		console.log('[gpuix] painted:', renderer.getPaintedText().join(' | ').slice(0, 3000));
		process.exit(0);
	}, 3000);
}

const loop = () => {
	const running = renderer.tick();
	drainAfterRender();
	if (running) setImmediate(loop);
};
loop();
