/**
 * One-off: measure controlsArea on a window booted with the app's exact
 * init options (titlebarTransparent + appOwnsTitlebarDrag → fullsize).
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer } from '@svelte-desktop/gpuix/native';
import { initPlatform, windows } from '@svelte-desktop/platform';

installGlobals();
const renderer = new GpuixRenderer((_err, payload) => {
	dispatchPayload(payload);
});
setRenderer(renderer);
renderer.init({
	title: 'controls probe',
	width: 400,
	height: 300,
	titlebarTransparent: true,
	appOwnsTitlebarDrag: true,
});
initPlatform(renderer);
const ticker = setInterval(() => renderer.tick(), 4);
const pump = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await pump(300);

console.log('transparent:', JSON.stringify(await windows.getControlsArea(0)));
console.log('bounds:', JSON.stringify(await windows.getBounds(0)));
console.log('size:', JSON.stringify(await windows.getSize(0)));

clearInterval(ticker);
process.exit(0);
