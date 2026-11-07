<script>
	// Mounts an icon in the macOS status bar (top-right). Renders nothing
	// in-window — the icon is native AppKit; `children` render inside a
	// borderless popover window positioned under the tray rect.
	//
	//   <StatusItem icon="/path/icon.png" badgeColor="#f00" items={[…]} />
	//   <StatusItem icon="add" /> — bare words are AppKit native image names
	//   <StatusItem icon="/path/icon.png" bind:open
	//     position={({width,height,displays}) => ({
	//       x: displays[0].workArea.x + (displays[0].workArea.width-width)/2,
	//       y: displays[0].workArea.y + displays[0].workArea.height-height-96,
	//     })}> — callback placement (Spotlight-style bottom-center)
	//     <div class="p-2">any native content</div>
	//   </StatusItem>
	//
	// Three modes: `items` → native dropdown menu; `children` → Svelte
	// popover (the snippet mounts into a second GPUI window sized to its
	// content); neither → plain icon whose `onClick` fires on trayClick.
	// Singleton — this component owns the app's one tray slot.
	import { tray, windows, screen, platformReady, onPlatformReady } from '../index.ts';
	import { createWindowRoot, destroyWindowRoot } from '@svelte-desktop/gpuix/gdom';
	import { toMenuItems, releaseItems, toIcon } from './items.js';

	let {
		icon = undefined,
		label = '',
		tooltip = undefined,
		badgeColor = undefined,
		items = undefined,
		onClick = undefined,
		open = $bindable(false),
		position = 'trayBottom',
		children = undefined,
	} = $props();

	const winLabel = `status-item:${Math.random().toString(36).slice(2)}`;
	let stageEl = null; // snippet host — reparented into the popover window
	let popRoot = null; // gdom window root
	let popId = null; // native windowId
	let shown = false;
	let trayRect = null; // last click's button rect — placement callback ctx

	// 'add' → native image name; './tray.png' / {path} → file; {native}
	// explicit. Either lands as a template image (badge composites over it).
	const iconSpec = $derived(toIcon(icon));

	// Effects can run before initPlatform (vite dev mounts the app first) —
	// gate on the bus and re-run when it binds.
	let ready = $state(platformReady());
	if (!ready) onPlatformReady(() => (ready = true));

	// ── tray state — teardown re-runs before each prop change and on
	// destroy, releasing this run's item callbacks ──
	$effect(() => {
		if (!ready) return;
		const specs = items?.length ? toMenuItems(items, `si:${label}`) : null;
		tray
			.set({
				imagePath: iconSpec && 'path' in iconSpec ? iconSpec.path : undefined,
				imageName: iconSpec && 'native' in iconSpec ? iconSpec.native : undefined,
				title: label,
				tooltip,
				badgeColor: badgeColor ?? null,
				// popover/bare-click mode needs trayClick to fire — an attached
				// menu makes AppKit swallow the click, so send explicit null.
				menu: specs ? { items: specs.specs } : null,
			})
			.catch((e) => console.error('[StatusItem] tray.set failed:', e));
		return () => releaseItems(specs?.ids ?? []);
	});

	// ── popover window ──
	async function ensurePopover() {
		if (popId != null) return popId;
		const { windowId } = await windows.create({
			label: winLabel,
			decorations: false,
			transparent: true,
			alwaysOnTop: true,
			resizable: false,
			movable: false,
			minimizable: false,
			// Ordered but non-key: an unordered window reports `screen == nil`
			// and every screen-relative positioning op falls back or no-ops.
			// The first show() does makeKeyAndOrderFront, so nothing steals
			// focus while invisible.
			focus: false,
			visible: true,
			// Generous staging size while hidden: start-aligned flex items
			// never stretch, so a roomy container lets them paint at exact
			// intrinsic size (a tiny window would squeeze them to min-content
			// and under-measure). fit() shrinks to content before show.
			width: 800,
			height: 600,
			// Invisible but on-screen: `visible:false` lands too late to stop
			// the first presented frame (the staged-rect flash), and an
			// offscreen frame breaks screen-relative positioning. Alpha 0 is
			// applied by create before the window ever presents.
			opacity: 0,
		});
		popId = windowId;
		popRoot = createWindowRoot(windowId);
		return windowId;
	}

	// Content-sized: union the children's painted bounds. The stage is a
	// flex row with start-aligned items, so each child keeps its intrinsic
	// size — the stage itself stretches to the window and must be skipped,
	// else the measurement chases the window and ratchets it wider.
	function contentExtent(el) {
		let w = 0;
		let h = 0;
		const walk = (n) => {
			if (n.nodeType === 1) {
				const b = n.getBoundingClientRect();
				w = Math.max(w, Math.ceil(b.x + b.width));
				h = Math.max(h, Math.ceil(b.y + b.height));
			}
			for (const c of n.childNodes ?? []) walk(c);
		};
		for (const c of el.childNodes ?? []) walk(c);
		return { w, h };
	}
	// The stage tracks the window so its own bounds can't signal content
	// changes — poll the extent while open (same 100ms cadence the gdom
	// ResizeObserver uses).
	let sizeTimer = null;
	function watchSize() {
		clearInterval(sizeTimer);
		let last = '';
		sizeTimer = setInterval(() => {
			if (popId == null || !open || !stageEl?.isConnected) return;
			const { w, h } = contentExtent(stageEl);
			const key = `${w}x${h}`;
			if (w > 0 && h > 0 && key !== last) {
				last = key;
				fit(w, h);
			}
		}, 100);
	}
	// Placement — `position` is a preset name ('trayBottom' default), a
	// fixed {x,y} in the window's screen coordinates, or a callback
	// evaluated at every fit so it can react to content-size changes.
	async function place(w, h) {
		let target = position;
		if (typeof target === 'function') {
			const displays = await screen.getAllDisplays().catch(() => []);
			target = target({
				width: w,
				height: h,
				tray: trayRect ?? undefined,
				displays,
			});
		}
		if (!target) return;
		if (typeof target === 'string')
			await windows.positionTo(target, popId).catch(async () => {
				// tray presets need a click rect — programmatic opens fall
				// back to center rather than stranding the window offscreen.
				if (target !== 'center')
					await windows.positionTo('center', popId).catch(() => {});
			});
		else
			await windows
				.setPosition(target.x, target.y, popId)
				.catch((e) => console.error('[StatusItem] setPosition:', e?.code, e?.message));
	}
	async function fit(w, h) {
		await windows.setSize(w, h, popId).catch((e) => console.error('[StatusItem] setSize:', e));
		await place(w, h).catch((e) => console.error('[StatusItem] place:', e));
		if (!shown) {
			await windows.show(popId).catch(() => {});
			await windows.setOpacity(1, popId).catch(() => {});
			shown = true;
		}
	}

	$effect(() => {
		// `open` + `stageEl` tracked — the {#if} below mounts the stage when
		// open flips; this reparents it into the popover window (moveBefore
		// relocates the live subtree — listeners and state survive).
		if (!ready || !open || !children || !stageEl) return;
		let cancelled = false;
		(async () => {
			await ensurePopover();
			if (cancelled || !stageEl?.isConnected) return;
			popRoot.appendChild(stageEl);
			// Hidden until it lands in the popover window — no win-0 flash.
			// Row-flex + start-aligned items: the snippet root paints at its
			// intrinsic size instead of stretching to the window, which is
			// what contentExtent measures.
			stageEl.style.display = 'flex';
			stageEl.style.alignItems = 'flex-start';
			stageEl.style.justifyContent = 'flex-start';
			watchSize();
		})().catch((e) => console.error('[StatusItem] popover failed:', e));
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		// Closing hides the window; the {#if} block destroys the stage.
		if (open || popId == null || !shown) return;
		shown = false;
		windows.hide(popId).catch(() => {});
	});

	// ── events + teardown ──
	$effect(() => {
		const offClick = tray.onClick((rect) => {
			if (rect && rect.width != null) trayRect = rect;
			onClick?.();
			if (children) open = !open;
		});
		const offFocus = windows.onFocusChanged(({ focused, windowId }) => {
			// Popover resigns key OR another window gains key → dismiss.
			if (!open || popId == null) return;
			if (windowId === popId && !focused) open = false;
			else if (focused && windowId != null && windowId !== popId) open = false;
		});
		const offClosed = windows.onClosed(({ windowId }) => {
			if (windowId !== popId) return;
			popId = null;
			popRoot = null;
			shown = false;
			if (open) open = false;
		});
		return () => {
			clearInterval(sizeTimer);
			offClick();
			offFocus();
			offClosed();
			tray.remove().catch(() => {});
			if (popId != null) {
				const id = popId;
				popId = null;
				windows.close(id).catch(() => {});
				destroyWindowRoot(id);
			}
		};
	});
</script>

{#if open && children}
	<div bind:this={stageEl} style="display:none">{@render children()}</div>
{/if}
