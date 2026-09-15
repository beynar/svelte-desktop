/**
 * Mission probe — startup stage timing + process RSS for the real window app.
 * `bun src/mission-startup.ts` — opens the real window, measures, exits.
 */
const T0 = performance.now();
const marks: Record<string, number> = {};
const mark = (label: string) => {
	const t = performance.now() - T0;
	marks[label] = t;
	const rss = process.memoryUsage.rss() / 1048576;
	console.log(`${label.padEnd(24)} t=${t.toFixed(1)}ms  rss=${rss.toFixed(1)}MiB`);
};

mark('process-ready');
const { GpuixRenderer } = await import('@gpuix/native');
mark('napi-loaded');
const { installGlobals, doc, materializeRoot, setViewport, dispatchPayload } = await import('./gdom');
const { setRenderer, flush, drainAfterRender } = await import('./native');
installGlobals();
mark('gdom-installed');

const renderer = new GpuixRenderer((err, payload) => { if (!err) dispatchPayload(payload); });
setRenderer(renderer);
mark('renderer-created');
renderer.init({ title: 'startup probe', width: 800, height: 600 });
mark('window-init');
setViewport(800, 580);

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:800px;height:580px');
doc.body.appendChild(target);
materializeRoot(target);
mark('root-materialized');

const { mount } = await import('../node_modules/svelte/src/index-client.js');
const Showcase = (await import('./gen/nkit/showcase/Showcase.js')).default;
mark('svelte-imported');
mount(Showcase, { target });
flush();
mark('showcase-mounted');

const loop = () => {
	const running = renderer.tick();
	drainAfterRender();
	if (running) setImmediate(loop);
};
loop();
mark('first-tick');

const steadyMs = Number(process.env.STEADY_MS ?? 3000);
setTimeout(() => {
	mark(`${steadyMs}ms-steady`);
	const s = (renderer as any).getDebugFrameOverlayStats?.();
	console.log('frameStats:', JSON.stringify(s));
	console.log('RESULT ' + JSON.stringify({ marks, rssMiB: process.memoryUsage.rss() / 1048576 }));
	process.exit(0);
}, steadyMs);
