import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';
import themeCss from './gen/theme-css.js';

installGlobals();

const renderer = new GpuixRenderer((err, payload) => {
	if (err) {
		console.error('[gpuix]', err);
		return;
	}
	dispatchPayload(payload);
});
setRenderer(renderer);
renderer.init({ title: 'svelte shadcn + streamdown → gpuix', width: 1180, height: 780 });
renderer.setDebugFrameOverlay('full'); // native fps/frame-time HUD over the scene
setViewport(1180, 780);

// feed the compiled shadcn theme into the classRules engine
const style = doc.createElement('style');
style.textContent = themeCss;
doc.head.appendChild(style);
doc.documentElement.classList.add('dark'); // streamdown darkMode + .dark vars

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:1180px;height:780px');
doc.body.appendChild(target);
materializeRoot(target);

const { mount } = await import('../node_modules/svelte/src/index-client.js');
const Dashboard = (await import('./gen/dashboard/Dashboard.js')).default;
mount(Dashboard, { target });
flush();

if (process.env.SHOT) {
	setTimeout(() => {
		renderer.captureScreenshot('/tmp/dash-1.png');
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
