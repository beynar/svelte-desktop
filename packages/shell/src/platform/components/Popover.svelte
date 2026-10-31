<script>
	// A route of the app shown in a native popover, opened from this page.
	//
	//   <button bind:this={btn} onclick={() => (open = !open)}>Emoji</button>
	//   <Popover route="/emoji" anchor={btn} bind:open width={280} height={220} />
	//
	//   <Popover route="/palette" style="panel" position="center" shortcut="Alt+Space" width={560} />
	//
	// `anchor`: an element of this page (arrow points at it), 'cursor', or a rect.
	// `style="panel"`: borderless translucent panel placed by `position`.
	// `shortcut`: a global hotkey that toggles it, even when the app is in the background.
	// The popover's web view is created on mount and kept warm: opening is instant.
	import { popover as popovers, shortcuts, onPlatform, platformReady, onPlatformReady } from '../index.ts';

	let {
		route = undefined,
		url = undefined,
		anchor = undefined,
		style = 'popover',
		position = undefined,
		edge = 'bottom',
		behavior = 'transient',
		width = 320,
		height = 240,
		shortcut = undefined,
		// Deterministic per route/style: re-creating after a reload replaces, never leaks.
		id = `popover:${style}:${route ?? url}`,
		open = $bindable(false),
		onShow = undefined,
		onHide = undefined,
		...rest
	} = $props();

	let created = $state(false);
	let shown = false;
	let ready = $state(platformReady());
	onPlatformReady(() => (ready = true)); // microtask when already bound

	$effect(() => {
		if (!ready) return;
		popovers
			.create({ id, route, url, style, edge, behavior, width, height, ...(position ? { position } : {}), ...rest })
			.then(() => (created = true))
			.catch((e) => console.error('[Popover] create failed:', e));
		return () => {
			created = false;
			shown = false;
			popovers.destroy(id).catch(() => {});
		};
	});

	function anchorSpec() {
		if (style === 'panel') return {};
		if (anchor instanceof Element) {
			const r = anchor.getBoundingClientRect();
			return { anchor: { x: r.x, y: r.y, width: r.width, height: r.height } };
		}
		return anchor ? { anchor } : { anchor: 'cursor' };
	}

	$effect(() => {
		const offs = [
			popovers.onShown((e) => {
				if (e.id !== id) return;
				shown = true;
				open = true;
				onShow?.();
			}),
			popovers.onHidden((e) => {
				if (e.id !== id) return;
				shown = false;
				open = false;
				onHide?.();
			}),
		];
		return () => offs.forEach((off) => off());
	});

	$effect(() => {
		if (!created) return;
		if (open && !shown) {
			shown = true;
			popovers.show(id, anchorSpec()).catch((e) => {
				shown = false;
				open = false;
				console.error('[Popover] show failed:', e);
			});
		} else if (!open && shown) {
			shown = false;
			popovers.hide(id).catch(() => {});
		}
	});

	// Global hotkey → toggle natively (works while the app is in the background).
	$effect(() => {
		if (!ready || !shortcut) return;
		const hotkey = `popover:${id}`;
		shortcuts.register({ accelerator: shortcut, id: hotkey }).catch((e) => console.error('[Popover] shortcut:', e));
		const off = onPlatform('shortcutPressed', (e) => {
			if (e?.id === hotkey) popovers.toggle(id, anchorSpec()).catch(() => {});
		});
		return () => {
			off();
			shortcuts.unregister({ id: hotkey }).catch(() => {});
		};
	});
</script>
