<script>
	// The app's icon in the macOS status bar (top-right), in one of three modes:
	//
	//   <StatusItem icon="note.text" items={[{ label: 'Quit', role: 'quit' }]} />   native menu
	//   <StatusItem icon="note.text" popover="/quick" bind:open />                 route in a popover
	//   <StatusItem icon="note.text" onClick={() => …} />                          plain click
	//
	// Popover mode: the route renders in its own pre-warmed web view (wrap it in
	// <PopoverContent> to size it to its content). Tray clicks toggle it natively,
	// with no round trip through this page. `style="panel"` gives a borderless
	// Spotlight-like panel; `position` places it — a preset, {x,y}, or a callback
	// ({width, height, tray, displays}) => preset | {x,y}, re-run on every resize.
	// Singleton — this component owns the app's one tray slot.
	import { tray, popover as popovers, screen, platformReady, onPlatformReady } from '../index.ts';
	import { toMenuItems, releaseItems, toIcon } from './items.js';

	let {
		icon = undefined,
		label = '',
		tooltip = undefined,
		badgeColor = undefined,
		items = undefined,
		onClick = undefined,
		popover = undefined,
		style = 'popover',
		width = 320,
		height = 240,
		position = 'tray',
		open = $bindable(false),
	} = $props();

	// Deterministic: a page reload (no teardown on unload) re-creates and replaces
	// the popover instead of leaking a second web view.
	const id = 'status-item';
	const options = $derived(typeof popover === 'string' ? { route: popover } : popover);
	let created = $state(false);
	let shown = false; // native truth, mirrored into `open`

	let ready = $state(platformReady());
	onPlatformReady(() => (ready = true)); // microtask when already bound

	// ── popover (created eagerly so the first open is instant) ──
	$effect(() => {
		if (!ready || !options) return;
		const opts = { id, width, height, style, position: typeof position === 'function' ? 'tray' : position, ...options };
		popovers
			.create(opts)
			.then(() => (created = true))
			.catch((e) => console.error('[StatusItem] popover.create failed:', e));
		return () => {
			created = false;
			popovers.destroy(id).catch(() => {});
		};
	});

	// ── tray item ──
	$effect(() => {
		if (!ready) return;
		const specs = items?.length ? toMenuItems(items, `si:${label}`) : null;
		const ico = toIcon(icon);
		tray
			.set({
				icon: ico ?? null,
				title: label,
				tooltip,
				badgeColor: badgeColor ?? null,
				// A menu makes AppKit swallow the click: popover/click modes need none.
				menu: specs ? { items: specs.specs } : null,
				popover: options && !specs ? id : null,
			})
			.catch((e) => console.error('[StatusItem] tray.set failed:', e));
		return () => releaseItems(specs?.ids ?? []);
	});

	// ── placement callback (panel style) ──
	async function place(size) {
		if (typeof position !== 'function') return;
		const [displays, rect] = await Promise.all([
			screen.getAllDisplays().catch(() => []),
			tray.getBounds().catch(() => null),
		]);
		const target = position({ width: size.width, height: size.height, tray: rect ?? undefined, displays });
		if (target) await popovers.setPosition(target, id).catch((e) => console.error('[StatusItem] place:', e));
	}

	// ── native → open ──
	$effect(() => {
		const offs = [
			popovers.onShown((e) => {
				if (e.id !== id) return;
				shown = true;
				open = true;
			}),
			popovers.onHidden((e) => {
				if (e.id !== id) return;
				shown = false;
				open = false;
			}),
			popovers.onResized((e) => e.id === id && place(e)),
			tray.onClick(() => onClick?.()),
		];
		return () => offs.forEach((off) => off());
	});

	// ── open → native (programmatic opens) ──
	$effect(() => {
		if (!created) return;
		if (open && !shown) {
			shown = true;
			popovers.show(id, style === 'panel' ? {} : { anchor: 'tray' }).then(
				(info) => place(info),
				(e) => {
					shown = false;
					open = false;
					console.error('[StatusItem] show failed:', e);
				},
			);
		} else if (!open && shown) {
			shown = false;
			popovers.hide(id).catch(() => {});
		}
	});

	$effect(() => () => tray.remove().catch(() => {}));
</script>
