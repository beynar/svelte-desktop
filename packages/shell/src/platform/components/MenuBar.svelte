<script>
	// Mounts one top-level entry in the macOS menu bar. Renders nothing —
	// it's a platform effect with component lifecycle. Re-mounts on prop
	// change; unmount removes the entry.
	//
	//   <MenuBar label="Tools" items={[
	//     { label: 'Refresh', icon: 'refresh', onClick: reload },
	//     { label: 'Mode', subItems: [{ label: 'Dark', onClick: dark }] },
	//     'separator',
	//     { label: 'Quit', role: 'quit' },
	//   ]} />
	//
	// `onClick` (no items) mounts a plain clickable bar entry instead.
	// Icons: 'name' → AppKit native image (NATIVE_ICON_NAMES), './x.png' →
	// file path, or explicit {native:…}/{path:…}.
	import { menu, platformReady, onPlatformReady } from '../index.ts';
	import { toIcon, toMenuItems, releaseItems, registerCallback, releaseCallback } from './items.js';

	let {
		label,
		icon = undefined,
		items = undefined,
		index = undefined,
		onClick = undefined,
	} = $props();

	// Effects can run before initPlatform (vite dev mounts the app first) —
	// gate on the bus and re-run when it binds.
	let ready = $state(platformReady());
	onPlatformReady(() => (ready = true)); // microtask when already bound

	$effect(() => {
		if (!ready) return;
		// label, icon, items, index, onClick all tracked — any change
		// re-inserts. The teardown releases this run's callbacks and drops
		// the entry, so renames and unmounts both clean up.
		const name = label;
		const specs = items?.length ? toMenuItems(items, `mb:${name}`) : null;
		const barId = onClick && !specs ? `bar:${name}` : null;
		if (barId) registerCallback(barId, onClick);
		menu
			.insert({
				name,
				icon: toIcon(icon),
				items: specs?.specs,
				index,
				id: barId ?? undefined,
			})
			.catch((e) => console.error('[MenuBar] insert failed:', e));
		return () => {
			releaseItems(specs?.ids ?? []);
			releaseCallback(barId);
			menu.remove(name).catch(() => {});
		};
	});
</script>
