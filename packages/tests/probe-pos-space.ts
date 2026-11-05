// Scratch: pin down setPosition/getPosition coordinate space on a
// multi-display setup. Creates a window, moves it, reads back, and dumps
// which display each op resolves.
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer } from '@svelte-desktop/gpuix/native';
import { initPlatform, windows, screen } from '@svelte-desktop/platform';

installGlobals();
const renderer = new GpuixRenderer((_err, payload) => {
	dispatchPayload(payload);
});
setRenderer(renderer);
renderer.init({ title: 'pos probe', width: 400, height: 300 });
initPlatform(renderer);
setInterval(() => renderer.tick(), 4);
const pump = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await pump(200);

const displays = await screen.getAllDisplays();
console.log('displays:', JSON.stringify(displays));
const near = await screen.getDisplayNearestWindow().catch((e) => String(e));
console.log('main-window display:', JSON.stringify(near));

const { windowId } = (await windows.create({
	label: 'pos-probe',
	width: 140,
	height: 90,
	// Unordered + invisible: NSWindow.screen is nil until orderFront —
	// the StatusItem staging shape. setPosition must still land.
	visible: false,
	focus: false,
	opacity: 0,
})) as { windowId: number };
await pump(200);
console.log('created window', windowId);

for (const [x, y] of [
	[300, 200],
	[100, 100],
	[700, 400],
] as const) {
	await windows.setPosition(x, y, windowId);
	await pump(120);
	const pos = await windows.getPosition(windowId);
	const b = ((await windows.getBounds(windowId)) as { bounds?: { x: number; y: number } })?.bounds;
	console.log(`set(${x},${y}) → get ${pos.x},${pos.y}  bounds ${b?.x},${b?.y}`);
}
// While hidden: positionTo('center') must resolve too (unordered window).
await windows.positionTo('center', windowId).catch((e) => console.log('positionTo err:', e));
await pump(80);
const c = await windows.getPosition(windowId);
console.log(`positionTo('center') while hidden → ${c.x},${c.y}`);
// After show: positions keep round-tripping on the real screen.
await windows.show(windowId);
await windows.setOpacity(1, windowId);
await pump(120);
await windows.setPosition(300, 200, windowId);
await pump(80);
const s = await windows.getPosition(windowId);
console.log(`after show set(300,200) → get ${s.x},${s.y}`);

await windows.close(windowId).catch(() => {});
await pump(100);
process.exit(0);
