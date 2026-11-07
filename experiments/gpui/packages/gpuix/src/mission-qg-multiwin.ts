/**
 * Mission probe — multi-window on the QuickGUI backend.
 * Worker side: opens two windows with separate Svelte trees, then closes.
 */
import { app, Window } from '@quickgui/native';
import { installGlobals, doc, materializeRoot } from './gdom';
import { setRenderer, flush } from './native';
import { QuickguiSink } from './qg-backend';

installGlobals();
await app.whenReady();

const { mount, unmount } = await import('../node_modules/svelte/src/index-client.js');
const App = (await import('./gen/App.js')).default;

let windows = 0;
let closedCleanups = 0;
const makeWindow = (title: string, offset: number) => {
	const w = new Window({
		title, width: 420, height: 300,
		renderer: (window) => {
			const sink = new QuickguiSink(window.root);
			setRenderer(sink as never);
			const target = doc.createElement('div');
			doc.body.appendChild(target);
			materializeRoot(target);
			const handle = mount(App, { target });
			flush(); window.flush();
			const t = setInterval(() => { flush(); window.flush(); }, 16);
			windows++;
			console.log(`window ${title} mounted (total: ${windows})`);
			return () => { clearInterval(t); unmount(handle).catch(() => {}); closedCleanups++; };
		},
	});
	w.onClose(() => console.log(`window ${title} closed`));
	return w;
};

const a = makeWindow('win-a', 0);
const b = makeWindow('win-b', 100);

// close win-a at 1.2s — win-b must keep rendering (app survives window close)
setTimeout(() => a.close(), 1200);

setTimeout(async () => {
	console.log(`multi-window probe: ${windows} mounted, win-a.closed=${a.closed}, win-b.closed=${b.closed}, cleanups=${closedCleanups}`);
	// orderly teardown: destroy remaining window, let its close land, then exit.
	// NOTE: app.destroy() from inside a timer races the host dispatch pump
	// (post-destroy flush throws "app has been destroyed") — exit directly.
	b.destroy();
	await new Promise((r) => setTimeout(r, 400));
	const ok = windows === 2 && a.closed && b.closed && closedCleanups >= 2;
	console.log(ok ? 'PASS: multi-window lifecycle' : 'FAIL');
	process.exit(ok ? 0 : 1);
}, 2500);
