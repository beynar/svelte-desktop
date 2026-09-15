/**
 * App module — runs inside the Bun worker after binding.initialize().
 * Same mount flow as main.ts, but the op sink is a QuickguiSink over
 * window.root instead of a GpuixRenderer.
 */
import { app, Window } from '@quickgui/native';
import { installGlobals, doc, materializeRoot } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';
import { QuickguiSink } from './qg-backend';

installGlobals();

await app.whenReady();

const { mount, unmount } = await import('../node_modules/svelte/src/index-client.js');
const App = (await import('./gen/App.js')).default;

new Window({
	title: 'svelte → quickgui (native)',
	width: 720,
	height: 640,
	renderer: (window) => {
		const sink = new QuickguiSink(window.root);
		setRenderer(sink as never);

		const target = doc.createElement('div');
		doc.body.appendChild(target);
		materializeRoot(target);

		const handle = mount(App, { target });
		// our emit() defers to setTimeout; kick the queued batch through now
		flush();
		window.flush();

		const interval = setInterval(() => {
			flush();
			window.flush();
			drainAfterRender();
		}, 16);

		return () => {
			clearInterval(interval);
			unmount(handle).catch(() => {});
			target.remove();
			flush();
			window.flush();
		};
	},
});

console.log('[qg] window created');
