/**
 * Kit app on QuickGUI — same mount flow as qg-mount.ts but mounts the
 * recursive Shell + router instead of App.svelte. Proves the kit layer is
 * backend-neutral: nothing here touches gpuix.
 */
import { app, Window } from '@quickgui/native';
import { installGlobals, doc, materializeRoot } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';
import { QuickguiSink } from './qg-backend';

installGlobals();

await app.whenReady();

new Window({
	title: 'sveltekit-shaped → quickgui (native)',
	width: 720,
	height: 640,
	renderer: (window) => {
		const sink = new QuickguiSink(window.root);
		setRenderer(sink as never);

		const target = doc.createElement('div');
		doc.body.appendChild(target);
		materializeRoot(target);

		let disposed = false;
		import('./kit-app.ts').then(({ startKit }) => startKit(target, '/'));
		flush();
		window.flush();

		const interval = setInterval(() => {
			if (disposed) return;
			flush();
			window.flush();
			drainAfterRender();
		}, 16);

		return () => {
			disposed = true;
			clearInterval(interval);
			target.remove();
			flush();
			window.flush();
		};
	},
});

console.log('[qg-kit] window created');
