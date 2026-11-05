/**
 * Live probe for menu.insert/menu.remove + tray badgeColor — the ops behind
 * MenuBar.svelte/StatusItem.svelte. Boots a real GPUI window, drives the
 * brokered ops, verifies menu.items() sees inserted entries and menuAction
 * routing stays intact.
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { setRenderer } from '@svelte-desktop/gpuix/native';
import { initPlatform, menu, tray, windows, onAnyPlatform } from '@svelte-desktop/platform';

installGlobals();
const renderer = new GpuixRenderer((_err, payload) => {
	dispatchPayload(payload);
});
setRenderer(renderer);
renderer.init({ title: 'menu/tray probe', width: 400, height: 300 });
initPlatform(renderer);

const seen: { event: string; data: unknown }[] = [];
onAnyPlatform((event, data) => seen.push({ event, data }));
const ticker = setInterval(() => renderer.tick(), 4);
const pump = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await pump(150);

let pass = 0;
let fail = 0;
const check = async (name: string, fn: () => Promise<unknown> | unknown) => {
	try {
		const v = await Promise.resolve().then(fn);
		console.log(`ok   ${name}`, v === undefined ? '' : JSON.stringify(v)?.slice(0, 160));
		pass++;
		return v;
	} catch (e) {
		const err = e as Error & { code?: string };
		console.log(`fail ${name}: [${err.code ?? 'ERR'}] ${err.message}`);
		fail++;
	}
};

// ── menu.insert: submenu mode ──
await check('menu.insert submenu', () =>
	menu.insert({
		name: 'Probe',
		items: [
			{ id: 'probe.one', label: 'One' },
			{ type: 'separator' },
			{
				label: 'Nested',
				submenu: [
					{ id: 'probe.deep', label: 'Deep' },
					{ id: 'probe.disabled', label: 'Off', disabled: true },
				],
			},
			{ label: 'Quit-ish', role: 'hide' },
		],
	}));

await pump(100);
const tree = (await check('menu.items sees Probe', () => menu.items())) as {
	text: string;
	submenu?: { id?: string; text?: string }[];
}[];
const probeMenu = tree?.find((m) => m.text === 'Probe');
if (probeMenu) {
	console.log('     Probe items:', JSON.stringify(probeMenu.submenu?.map((i) => i.text)));
	pass++;
} else {
	console.log('fail menu.items: no Probe entry');
	fail++;
}
// Spec correlation must survive the foreign entry — the gpui-owned menus
// still resolve by id.
await check('menu.get(probe.one)', () => menu.get('probe.one'));
await check('menu.get(probe.deep) nested', () => menu.get('probe.deep'));
await check('menu.update on inserted item', () =>
	menu.update({ id: 'probe.one', text: 'Uno' }));

// ── menu.insert: clickable bar item ──
await check('menu.insert clickable', () =>
	menu.insert({ name: 'Ping', id: 'probe.bar.ping', icon: { native: 'add' } }));
await pump(80);

// Re-insert replaces rather than duplicates.
await check('menu.insert replace', () =>
	menu.insert({ name: 'Probe', items: [{ id: 'probe.two', label: 'Two' }] }));
await pump(80);
const tree2 = (await menu.items()) as { text: string }[];
const count = tree2.filter((m) => m.text === 'Probe').length;
if (count === 1) {
	console.log('ok   replace dedupes');
	pass++;
} else {
	console.log(`fail replace: ${count} Probe entries`);
	fail++;
}

await check('menu.remove Probe', () => menu.remove('Probe'));
await check('menu.remove Ping', () => menu.remove('Ping'));
await check('menu.remove missing → error', async () => {
	try {
		await menu.remove('Probe');
		throw new Error('should have failed');
	} catch (e) {
		if ((e as { code?: string }).code === 'unavailable') return 'unavailable';
		throw e;
	}
});

// ── tray + badgeColor ──
const ICON = '/tmp/gpuix-probe-icon.png';
// 16x16 red-ish PNG via Bun — a tiny fixture is fine for compositing.
await Bun.write(
	ICON,
	Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4nGNgGAWjYOgD' +
			'Rhgy9P8/AwMDI8OoBgYGJgYGBkYGBgZGBgYGJgYGBgZGJgAABmAB/6r4fxoAAAAASUVORK5CYII=',
		'base64',
	),
);
await check('tray.set plain', () => tray.set({ title: 'P', imagePath: ICON }));
await check('tray.set badge #ff3b30', () =>
	tray.set({ title: 'P', imagePath: ICON, badgeColor: '#ff3b30' }));
await check('tray.set badge clears', () =>
	tray.set({ title: 'P', imagePath: ICON, badgeColor: null }));
await check('tray.set bad color → error', async () => {
	try {
		await tray.set({ badgeColor: 'not-a-color' });
		throw new Error('should have failed');
	} catch (e) {
		if ((e as { code?: string }).code === 'invalid_args') return 'invalid_args';
		throw e;
	}
});
// Icon sources: native image names + file paths through every arg shape.
await check('tray.set imageName native', () => tray.set({ imageName: 'add' }));
await check('tray.set icon:{native}', () => tray.set({ icon: { native: 'refresh' } }));
await check('tray.set icon:{path}', () => tray.set({ icon: { path: ICON } }));
await check('tray.set bad imageName → error', async () => {
	try {
		await tray.set({ imageName: 'bogus' as never });
		throw new Error('should have failed');
	} catch (e) {
		if ((e as { code?: string }).code === 'invalid_args') return 'invalid_args';
		throw e;
	}
});
// toIcon routing: path-looking strings → {path}, bare words → {native}.
const { toIcon } = await import('@svelte-desktop/platform/gen/components/items.js');
const routed =
	(toIcon('add') as { native?: string })?.native === 'add' &&
	(toIcon('./x.png') as { path?: string })?.path === './x.png' &&
	(toIcon('/abs/x') as { path?: string })?.path === '/abs/x' &&
	(toIcon({ native: 'share' }) as { native?: string })?.native === 'share' &&
	toIcon(undefined) === undefined;
console.log(`${routed ? 'ok  ' : 'fail'} toIcon routes string/object sources`);
routed ? pass++ : fail++;
await check('tray.isSet', async () => ((await tray.isSet()) ? 'set' : Promise.reject(new Error('not set'))));
await check('tray.remove', () => tray.remove());

// ── components: real mounts through the compiled gen path ──
const { compile } = await import('svelte/compiler');
const FIXTURE = `<script>
	import MenuBar from '@svelte-desktop/platform/gen/components/MenuBar.js';
	import StatusItem from '@svelte-desktop/platform/gen/components/StatusItem.js';
	let { onAction = () => {} } = $props();
	let open = $state(false);
	globalThis.__probeOpen = (v) => (open = v);
</script>
<MenuBar label="Tools" items={[
	{ label: 'Alpha', onClick: () => onAction('alpha') },
	{ label: 'More', subItems: [{ label: 'Deep', onClick: () => onAction('deep') }] },
	'separator',
	{ label: 'Hide-ish', role: 'hide' },
]} />
<StatusItem icon="${ICON}" label="SI" badgeColor="#ff3b30" bind:open
	position={({ width, height, displays }) => (
		(globalThis.__probePlacement = { width, height, displays: displays.length }),
		{ x: 300, y: 200 }
	)}>
	<div style="width:140px;height:90px">popover content</div>
</StatusItem>`;
const fixtureJs = compile(FIXTURE, { generate: 'client', filename: 'probe-chrome.svelte' }).js.code;
await Bun.write(
	new URL('./gen/cases/_probe_chrome.js', import.meta.url).pathname,
	fixtureJs,
);
const Chrome = (await import('./gen/cases/_probe_chrome.js')).default;
const { mount, unmount } = await import('@svelte-desktop/svelte/svelte-client.js');

const fired: string[] = [];
const appChrome = mount(Chrome, {
	target: (globalThis as { document: { body: unknown } }).document.body as never,
	props: { onAction: (id: string) => fired.push(id) },
});
await pump(150);

const tree3 = (await menu.items()) as { text: string; submenu?: { text?: string }[] }[];
const tools = tree3.find((m) => m.text === 'Tools');
console.log(`${tools ? 'ok  ' : 'fail'} MenuBar mounted — Tools in bar: ${JSON.stringify(tools?.submenu?.map((i) => i.text))}`);
tools ? pass++ : fail++;
await check('StatusItem → tray.isSet', async () =>
	(await tray.isSet()) ? 'set' : Promise.reject(new Error('not set')));

// Popover: open → window created, sized to the stage's native bounds.
(globalThis as { __probeOpen: (v: boolean) => void }).__probeOpen(true);
await pump(600); // create → reparent → layout → RO poll (100ms) → fit → show
const wins = (await windows.list().catch(() => [])) as {
	windowId: number;
	label: string;
	bounds: { width: number; height: number };
}[];
const pop = wins.find((w) => w.label.startsWith('status-item:'));
if (pop) {
	console.log(`ok   popover window ${pop.windowId} at ${pop.bounds.width}×${pop.bounds.height}`);
	pass++;
	const sized = Math.abs(pop.bounds.width - 140) < 24 && Math.abs(pop.bounds.height - 90) < 24;
	console.log(`${sized ? 'ok  ' : 'fail'} popover content-sized`);
	sized ? pass++ : fail++;
	// Placement callback ran with content size + displays and set the origin.
	await pump(150);
	const placement = (globalThis as { __probePlacement?: { width: number; displays: number } })
		.__probePlacement;
	const pos = await windows
		.getPosition(pop.windowId)
		.catch(() => ({ x: -1, y: -1 }));
	const placed =
		placement?.displays > 0 &&
		Math.abs(placement.width - pop.bounds.width) < 24 &&
		Math.abs(pos.x - 300) < 8 &&
		Math.abs(pos.y - 200) < 8;
	console.log(
		`${placed ? 'ok  ' : 'fail'} placement callback → ${pos.x},${pos.y} (ctx ${JSON.stringify(placement)})`,
	);
	placed ? pass++ : fail++;
	// The size poll must not ratchet — bounds identical five intervals on.
	await pump(500);
	const later = ((await windows.list().catch(() => [])) as typeof wins).find(
		(w) => w.windowId === pop.windowId,
	);
	const stable =
		later?.bounds.width === pop.bounds.width &&
		later?.bounds.height === pop.bounds.height;
	console.log(`${stable ? 'ok  ' : 'fail'} popover size stable (${later?.bounds.width}×${later?.bounds.height})`);
	stable ? pass++ : fail++;
} else {
	console.log('fail popover window missing');
	fail++;
}
(globalThis as { __probeOpen: (v: boolean) => void }).__probeOpen(false);
await pump(200);

// Rapid toggle burst — every hide/show fires AppKit window callbacks while
// platform ops hold the App borrow; gpui defers those notifications and they
// must land without `RefCell already borrowed` errors (watch stderr).
for (let i = 0; i < 8; i++) {
	(globalThis as { __probeOpen: (v: boolean) => void }).__probeOpen(true);
	await pump(140);
	(globalThis as { __probeOpen: (v: boolean) => void }).__probeOpen(false);
	await pump(140);
}
(globalThis as { __probeOpen: (v: boolean) => void }).__probeOpen(true);
await pump(600);
const reopened = ((await windows.list().catch(() => [])) as typeof wins).find(
	(w) => w.label.startsWith('status-item:'),
);
const repos = reopened
	? await windows.getPosition(reopened.windowId).catch(() => ({ x: -1, y: -1 }))
	: { x: -1, y: -1 };
const reok =
	reopened &&
	reopened.bounds.width === 140 &&
	reopened.bounds.height === 90 &&
	Math.abs(repos.x - 300) < 8 &&
	Math.abs(repos.y - 200) < 8;
console.log(
	`${reok ? 'ok  ' : 'fail'} rapid-toggle reopen → ${reopened ? `${reopened.bounds.width}×${reopened.bounds.height} @ ${repos.x},${repos.y}` : 'missing'}`,
);
reok ? pass++ : fail++;

// controlsArea: titled main window → 3-button cluster in frame space
// (y ≥ 0 from the window's top edge, contentTop = titlebar inset);
// borderless popover → null.
const controlsArea = (await windows.getControlsArea(0).catch(() => null)) as {
	y?: number;
	contentTop?: number;
	side?: string;
	buttons?: { close?: unknown; minimize?: unknown; zoom?: unknown };
} | null;
const allButtons =
	controlsArea?.side === 'left' &&
	(controlsArea.y ?? -1) >= 0 &&
	(controlsArea.contentTop ?? -1) >= 0 &&
	controlsArea.buttons?.close &&
	controlsArea.buttons.minimize &&
	controlsArea.buttons.zoom;
console.log(`${allButtons ? 'ok  ' : 'fail'} controlsArea main → ${JSON.stringify(controlsArea)}`);
allButtons ? pass++ : fail++;
const popControls = await windows
	.getControlsArea(reopened?.windowId)
	.catch(() => 'err' as const);
console.log(
	`${popControls === null ? 'ok  ' : 'fail'} controlsArea borderless → ${JSON.stringify(popControls)}`,
);
popControls === null ? pass++ : fail++;
(globalThis as { __probeOpen: (v: boolean) => void }).__probeOpen(false);
await pump(200);

await unmount(appChrome);
await pump(150);
const tree4 = (await menu.items()) as { text: string }[];
const gone = !tree4.some((m) => m.text === 'Tools');
console.log(`${gone ? 'ok  ' : 'fail'} MenuBar unmount removed Tools`);
gone ? pass++ : fail++;
await check('StatusItem unmount → tray gone', async () =>
	(await tray.isSet()) === false ? 'removed' : Promise.reject(new Error('still set')));

// menuAction events must still route — nothing fired them here (no real
// clicks), but the subscription path must not error.
console.log(`\nseen events: ${seen.map((s) => s.event).join(', ') || '(none)'}`);

clearInterval(ticker);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
