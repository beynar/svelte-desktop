// scratch: render a statically-open popover over page content — verifies the
// panel floats without occluding the page (no backdrop since Layer v2)
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';

installGlobals();

const renderer = new GpuixRenderer((err, payload) => {
	if (err) console.error('[gpuix]', err);
	else dispatchPayload(payload);
});
setRenderer(renderer);
const W = 640, H = 400;
renderer.init({ title: 'popover-open', width: W, height: H });
setViewport(W, H);

const target = doc.createElement('div');
target.setAttribute('style', `display:flex;flex-direction:column;width:${W}px;height:${H}px;background-color:#0d1117;padding:40px;gap:16px`);
doc.body.appendChild(target);
materializeRoot(target);

const { mount, createRawSnippet } = await import('../node_modules/svelte/src/index-client.js');
const Popover = (await import('./gen/nkit/Popover.js')).default;
mount(Popover, {
	target,
	props: {
		open: true,
		trigger: createRawSnippet(() => ({ render: () => `<div style="color:#e6edf3;padding:8px 16px;background-color:#1f6feb;border-radius:6px">TRIGGER-VISIBLE</div>` })),
		children: createRawSnippet(() => ({ render: () => `<div style="color:#e6edf3">pop-body-content</div>` })),
	},
});
flush();

setTimeout(() => {
	renderer.captureScreenshot('/tmp/pop-open.png');
	console.log('[gpuix] painted:', renderer.getPaintedText().join(' | '));
	process.exit(0);
}, 2500);

const loop = () => {
	const running = renderer.tick();
	drainAfterRender();
	if (running) setImmediate(loop);
};
loop();
