<!--
	The panes of <WindowTabs split>: a tree of splits, each pane with its own bar. Internal: `content`
	renders it.

	Every tab's view is placed from one flat list, not from inside its pane: a tab moving to another
	pane keeps its view, and its page goes on running. Views are drawn over the page, so what shows
	while a tab is dragged is made room for: the view over a drop zone shrinks off it.
-->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { useTabs, type TabLike, type TabRender } from './tabs.svelte.ts';
	import type { PaneLeaf, PaneNode, PaneSplit, PaneZone } from './panes.svelte.ts';
	import { isolatedView } from './isolated.ts';
	import { pointerDrag } from './pointer-drag.ts';
	import { callPlatform } from '../platform/bus';
	import { webview as webviewStore } from '../platform/stores.svelte';
	import TabBar from './TabBar.svelte';

	type BarProps = { class?: string; label?: string; newTabLabel?: string; start?: Snippet; end?: Snippet };

	interface Props {
		class?: string;
		bar?: BarProps;
		tab?: Snippet<[TabRender]>;
		minPaneSize?: number;
		/** Accessible name of the line between two panes. */
		resizeLabel?: string;
	}

	let { class: className = '', bar, tab, minPaneSize = 180, resizeLabel = 'Resize panes' }: Props = $props();
	const tabs = useTabs();
	const panes = tabs.panes!;
	const edges = $derived(panes.edges());
	/** How far past the gap the line between two panes can be grabbed, each side (px). */
	const GRAB = 4;

	// What the panes held before this component: a tab gone since is gone, not one to wait for.
	let known = new Set(panes.panes.flatMap((p) => p.tabs));
	// Tabs changed by your code (bind:tabs): their panes follow. The active tab too (bind:value): its
	// pane shows it and has the focus, a tab that comes after its value included.
	$effect.pre(() => {
		const ids = tabs.items.map((t) => t.id);
		const active = tabs.activeId;
		untrack(() => {
			panes.reconcile(ids);
			const pane = active ? panes.paneOf(active) : undefined;
			// It was here and it's gone: what its pane shows now. (Not there yet: when it comes.)
			if ((active && !pane && known.has(active)) || (!active && panes.focused.active)) {
				const next = panes.focused.active;
				tabs.activeId = null;
				if (next) tabs.activate(next, 'missing');
			} else if (pane && (pane.active !== active || pane.id !== panes.focusedId)) tabs.activate(active!);
			known = new Set(ids);
			tabs.syncViews();
		});
	});

	/** A pane's box for its view: the body's, off the drop zone while a tab is dragged over it. */
	function boxOf(pane: string) {
		const b = placed(pane);
		if (!b) return null;
		// The page's CSS pixels, its zoom applied: what the window's coordinates are. The edges are
		// rounded, not the size: two panes' shared edge stays one.
		const zoom = webviewStore.zoom ?? 1;
		const x = Math.round(b.x * zoom);
		const y = Math.round(b.y * zoom);
		return { x, y, width: Math.round((b.x + b.width) * zoom) - x, height: Math.round((b.y + b.height) * zoom) - y };
	}
	function placed(pane: string): Box | null {
		const body = document.querySelector(`[data-sd-pane="${pane}"] > [data-sd-pane-body]`);
		if (!body) return null;
		const r = body.getBoundingClientRect();
		const box: Box = { x: r.left, y: r.top, width: r.width, height: r.height };
		const drop = panes.drop;
		if (!drop || drop.kind === 'bar') return box;
		if (drop.kind === 'center') return drop.pane === pane ? { x: box.x + 6, y: box.y + 6, width: Math.max(0, box.width - 12), height: Math.max(0, box.height - 12) } : box;
		if (drop.kind === 'side') return drop.pane === pane ? off(box, drop.zone, 0.5) : box;
		// A whole side of the window: every pane there makes room.
		const root = document.querySelector(`[data-sd-panes="${tabs.id}"]`)?.getBoundingClientRect();
		if (!root) return box;
		const band = (drop.zone === 'left' || drop.zone === 'right' ? root.width : root.height) * 0.25;
		return clip(box, drop.zone, root, band);
	}
	type Box = { x: number; y: number; width: number; height: number };
	const off = (b: Box, zone: PaneZone, share: number): Box =>
		zone === 'left' ? { ...b, x: b.x + b.width * share, width: b.width * (1 - share) }
		: zone === 'right' ? { ...b, width: b.width * (1 - share) }
		: zone === 'top' ? { ...b, y: b.y + b.height * share, height: b.height * (1 - share) }
		: { ...b, height: b.height * (1 - share) };
	function clip(b: Box, zone: PaneZone, root: DOMRect, band: number): Box {
		// A pane entirely in the band: nothing left of it (its view steps aside).
		if (zone === 'left') {
			const edge = root.left + band;
			return b.x >= edge ? b : { ...b, x: edge, width: Math.max(0, b.width - (edge - b.x)) };
		}
		if (zone === 'right') return { ...b, width: Math.max(0, Math.min(b.width, root.right - band - b.x)) };
		return { ...b, height: Math.max(0, Math.min(b.height, root.bottom - band - b.y)) };
	}

	// What a split's children share: its length without the boundaries.
	function lengthOf(split: PaneSplit): number {
		const el = document.querySelector(`[data-sd-split-id="${split.id}"]`);
		const line = el?.querySelector(':scope > [data-sd-splitter]');
		if (!el || !line) return 0;
		const r = el.getBoundingClientRect();
		const l = line.getBoundingClientRect();
		return split.direction === 'row' ? r.width - l.width * (split.children.length - 1) : r.height - l.height * (split.children.length - 1);
	}
	let rootNode: HTMLElement | undefined;
	/** How thick the boundaries are, by direction. */
	const gaps = () => {
		const of = (direction: 'row' | 'column') => {
			const r = rootNode?.querySelector(`[data-sd-splitter="${direction}"]`)?.getBoundingClientRect();
			return r ? (direction === 'row' ? r.width : r.height) : 0;
		};
		return { row: of('row'), column: of('column') };
	};
	function fit() {
		// The room for the tree: the first child of the panes, without their padding.
		const box = rootNode?.firstElementChild?.getBoundingClientRect();
		if (box) panes.fit({ width: box.width, height: box.height }, minPaneSize, gaps());
	}

	/** Calls back when the panes' bodies move without changing size (something above them got taller,
	 *  the padding around them changed): nothing observes that, whatever clips them, so they're looked
	 *  at a few times a second. */
	function watchPositions(node: HTMLElement, moved: () => void) {
		let at = '';
		const look = () => {
			let here = '';
			for (const body of node.querySelectorAll('[data-sd-pane-body]')) {
				const r = body.getBoundingClientRect();
				here += `${r.left} ${r.top} ${r.width} ${r.height} `; // its size too: a transform changes it unseen
			}
			if (at && here !== at) moved();
			at = here;
		};
		look();
		const timer = setInterval(look, 250);
		return () => clearInterval(timer);
	}

	// The window resized, the sidebar moved: panes move without a tab changing.
	function observe(node: HTMLElement) {
		rootNode = node;
		panes.rtl = getComputedStyle(node).direction === 'rtl';
		const stopWatching = watchPositions(node, () => panes.revision++);
		// The app's language changes it, not a size.
		const direction = setInterval(() => (panes.rtl = getComputedStyle(node).direction === 'rtl'), 250);
		// The page's zoom changes the size of everything in it, whoever changed it (a menu's zoom role).
		const zoomed = () => void webviewStore.refresh();
		// A field of the window's page chosen, or anything reached with the keyboard (the line between two
		// panes): a view coming on screen doesn't take the keyboard from it
		// (on Windows, not a request made before it was ready either).
		const chosen = (e: FocusEvent) => {
			if (!(e.target instanceof Element && e.target.matches('input, textarea, select, [contenteditable], [data-sd-splitter], :focus-visible'))) return;
			// In a pane's bar: what the keyboard does next (close, next tab) is about that pane.
			const pane = e.target.closest('[data-sd-pane]')?.getAttribute('data-sd-pane');
			if (pane && pane !== panes.focusedId) tabs.focus(pane, { keyboard: false });
			tabs.pageKeyboard = true;
			if (/Win/.test(navigator.platform)) void callPlatform('view', 'forgetFocus').catch(() => {});
		};
		addEventListener('focusin', chosen);
		let warned = false;
		const observer = new ResizeObserver(() => {
			// Pages are drawn in what the panes are given: nothing here, nothing shows, and nothing would say why.
			if (!warned && node.getBoundingClientRect().height < 1 && import.meta.env?.DEV) {
				warned = true;
				console.warn('[tabs] the panes have no height, so no page can show: give what `content` is rendered in a height, down from the window.');
			}
			panes.rtl = getComputedStyle(node).direction === 'rtl';
			fit();
			panes.revision++;
			zoomed();
		});
		observer.observe(node);
		addEventListener('resize', zoomed);
		return {
			destroy() {
				observer.disconnect();
				stopWatching();
				clearInterval(direction);
				removeEventListener('resize', zoomed);
				removeEventListener('focusin', chosen);
				rootNode = undefined;
			},
		};
	}
	// A pane's body moved without the panes changing (its bar got taller): its view follows.
	function observeBody(node: HTMLElement) {
		const observer = new ResizeObserver(() => void panes.revision++);
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}
	// A pane made or gone: within the minimum too, once it's drawn.
	$effect(() => {
		void panes.panes.length;
		untrack(fit);
	});

	/** The boundary being dragged. */
	let resizing = $state<string | null>(null);
	const boundary = (split: PaneSplit, index: number) => `${split.id}:${index}`;

	// A split's boundary. Its size comes from the press and the pointer's distance from it, not from
	// the last move: past the minimum and back, it stays under the pointer.
	function splitter(node: HTMLElement, params: { split: PaneSplit; index: number }) {
		let p = params;
		let start: { a: number; origin: number; length: number; flip: number; delta: number } | null = null;
		// What the panes on each side need, nested ones included.
		const min = (length: number) => panes.minShares(p.split, p.index, minPaneSize, gaps(), length);
		const stop = () => {
			start = null;
			resizing = null;
			document.documentElement.removeAttribute('data-sd-pane-resizing');
		};
		const off = pointerDrag(node, {
			onStart() {
				const row = p.split.direction === 'row';
				const a = p.split.sizes[p.index]!;
				start = { a, origin: a, length: lengthOf(p.split), flip: row && getComputedStyle(node).direction === 'rtl' ? -1 : 1, delta: 0 };
				resizing = boundary(p.split, p.index);
				document.documentElement.setAttribute('data-sd-pane-resizing', p.split.direction);
			},
			onMove({ deltaX, deltaY }) {
				if (!start) return;
				const length = lengthOf(p.split);
				if (!length) return;
				// The window resized meanwhile: on from where the boundary is now, at the new size.
				if (length !== start.length) {
					start.a = p.split.sizes[p.index]! - start.delta / length;
					start.length = length;
				}
				start.delta = (p.split.direction === 'row' ? deltaX : deltaY) * start.flip;
				panes.resizeTo(p.split.id, p.index, start.a + start.delta / length, min(length));
			},
			onEnd() {
				stop();
				// The press took the keyboard to the window's page: back to the pane in focus.
				tabs.focus(panes.focusedId);
			},
			onCancel() {
				const was = start;
				stop();
				// Where it was, within what the window allows now.
				if (was) panes.resizeTo(p.split.id, p.index, was.origin, min(lengthOf(p.split)));
				tabs.focus(panes.focusedId);
			},
		});
		const key = (e: KeyboardEvent) => {
			const row = p.split.direction === 'row';
			const flip = row && getComputedStyle(node).direction === 'rtl' ? -1 : 1;
			const length = lengthOf(p.split);
			const share = p.split.sizes[p.index]!;
			const pair = share + p.split.sizes[p.index + 1]!;
			const to =
				e.key === (row ? 'ArrowRight' : 'ArrowDown') ? share + (24 * flip) / length
				: e.key === (row ? 'ArrowLeft' : 'ArrowUp') ? share - (24 * flip) / length
				: e.key === 'Home' ? 0
				: e.key === 'End' ? pair
				: null;
			// What a double click on it does.
			if (e.key === 'Enter') {
				e.preventDefault();
				panes.resetBoundary(p.split.id, p.index);
				return fit();
			}
			if (to === null || !length) return;
			e.preventDefault();
			panes.resizeTo(p.split.id, p.index, to, min(length));
		};
		const twice = (e: MouseEvent) => {
			e.preventDefault();
			panes.resetBoundary(p.split.id, p.index);
			fit();
		};
		node.addEventListener('keydown', key);
		node.addEventListener('dblclick', twice);
		return {
			update: (next: { split: PaneSplit; index: number }) => void (p = next),
			destroy() {
				off();
				node.removeEventListener('keydown', key);
				node.removeEventListener('dblclick', twice);
			},
		};
	}

	/** The drop zone drawn in a pane, where its view made room. */
	const zoneIn = (pane: PaneLeaf) => {
		const d = panes.drop;
		if (d?.kind === 'center' && d.pane === pane.id) return 'center';
		if (d?.kind === 'side' && d.pane === pane.id) return d.zone;
		return null;
	};
	const rootZone = $derived(panes.drop?.kind === 'root' ? panes.drop.zone : null);
</script>

{#snippet node(n: PaneNode)}
	{#if n.type === 'pane'}
		{@const e = edges.get(n.id)}
		<!-- A press in a pane's bar puts it in focus; a press in its view says so natively (viewFocused). -->
		<div
			role="group"
			aria-labelledby={n.active ? `${tabs.id}-tab-${n.active}` : undefined}
			data-sd-pane={n.id}
			data-focused={n.id === panes.focusedId || undefined}
			data-top={e?.top || undefined}
			data-right={e?.right || undefined}
			data-bottom={e?.bottom || undefined}
			data-left={e?.left || undefined}
			onpointerdowncapture={(e) => {
				if (n.id === panes.focusedId) return;
				// A press on a tab may be a drag: the keyboard stays in the page until it's let go.
				tabs.focus(n.id, { keyboard: !(e.target instanceof Element && e.target.closest('[role=tab]')) });
			}}
		>
			<TabBar {...bar} pane={n} {tab} />
			<!-- The tab's page is drawn over this, in a web view of its own: empty here. -->
			<div
				id={`${tabs.id}-pane-body-${n.id}`}
				role="tabpanel"
				aria-labelledby={n.active ? `${tabs.id}-tab-${n.active}` : undefined}
				data-sd-pane-body
				use:observeBody
			>
				{#if zoneIn(n)}<div data-sd-pane-drop={zoneIn(n)} aria-hidden="true"></div>{/if}
			</div>
		</div>
	{:else}
		<div data-sd-split={n.direction} data-sd-split-id={n.id}>
			{#each n.children as child, i (child.id)}
				{#if i > 0}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
					<div
						role="separator"
						tabindex="0"
						aria-orientation={n.direction === 'row' ? 'vertical' : 'horizontal'}
						aria-label={resizeLabel}
						aria-valuenow={Math.round(n.sizes[i - 1]! * 100)}
						aria-valuemin={0}
						aria-valuemax={Math.round((n.sizes[i - 1]! + n.sizes[i]!) * 100)}
						aria-controls={`${tabs.id}-pane-${n.children[i - 1]!.id} ${tabs.id}-pane-${child.id}`}
						data-sd-splitter={n.direction}
						data-desktop-no-drag
						data-dragging={resizing === boundary(n, i - 1) || undefined}
						use:splitter={{ split: n, index: i - 1 }}
					></div>
				{/if}
				<div id={`${tabs.id}-pane-${child.id}`} data-sd-pane-slot style:flex-grow={n.sizes[i]}>{@render node(child)}</div>
			{/each}
		</div>
	{/if}
{/snippet}

<div data-sd-panes={tabs.id} class={className} use:observe>
	{@render node(panes.root)}
	{#if rootZone}<div data-sd-pane-drop={rootZone} data-sd-pane-drop-root aria-hidden="true"></div>{/if}
	{#each tabs.items as t (t.id)}
		{@const pane = panes.paneOf(t.id)}
		{#if pane}
			<div
				hidden
				data-sd-tabview
				use:isolatedView={{
					tabs,
					tab: t,
					active: pane.active === t.id,
					shown: pane.shown === t.id,
					suspended: tabs.suspended.has(t.id),
					box: () => boxOf(pane.id),
					grab: () => {
						// Beside another pane; its top is under its own bar.
						const e = edges.get(pane.id);
						return e ? { top: 0, right: e.right ? 0 : GRAB, bottom: e.bottom ? 0 : GRAB, left: e.left ? 0 : GRAB } : null;
					},
					revision: `${panes.revision} ${JSON.stringify(panes.drop)} ${webviewStore.zoom}`,
				}}
			></div>
		{/if}
	{/each}
</div>

<style>
	/* Layout only, at zero specificity: the app's classes win. */
	:where([data-sd-panes]) {
		position: relative;
		display: flex;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
	:where([data-sd-panes] > [data-sd-pane], [data-sd-panes] > [data-sd-split]) {
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
	}
	:where([data-sd-split]) {
		display: flex;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
	:where([data-sd-split='column']) {
		flex-direction: column;
	}
	:where([data-sd-pane-slot]) {
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		display: flex;
	}
	:where([data-sd-pane]) {
		display: flex;
		flex-direction: column;
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
	}
	:where([data-sd-pane] > [data-sd-tabbar]) {
		flex: none;
	}
	:where([data-sd-pane-body]) {
		position: relative;
		flex: 1 1 0;
		min-height: 0;
	}
	/* A boundary. The room to grab it is the gap itself: the panes' views take everything else, and
	   nothing of the page's can reach over them. A line down its middle shows it. */
	:where([data-sd-splitter]) {
		position: relative;
		flex: none;
		touch-action: none;
		outline: none;
	}
	:where([data-sd-splitter='row']) {
		width: var(--sd-pane-gap, 6px);
		cursor: col-resize;
	}
	:where([data-sd-splitter='column']) {
		height: var(--sd-pane-gap, 6px);
		cursor: row-resize;
	}
	:where([data-sd-splitter])::before {
		/* More to grab than the gap: a thin gap stays usable. Over the bars, and over the views where they
		   leave it to the page (GRAB, macOS). */
		content: '';
		position: absolute;
		inset: -4px;
		z-index: 1;
	}
	:where([data-sd-splitter])::after {
		content: '';
		position: absolute;
		border-radius: 1px;
		background: var(--sd-pane-splitter, transparent);
		transition: background-color 120ms;
	}
	:where([data-sd-splitter='row'])::after {
		inset: 8px auto 8px 50%;
		width: 2px;
		margin-left: -1px;
	}
	:where([data-sd-splitter='column'])::after {
		inset: 50% 8px auto 8px;
		height: 2px;
		margin-top: -1px;
	}
	:where([data-sd-splitter]:hover, [data-sd-splitter]:focus-visible)::after {
		background: var(--sd-pane-splitter-hover, color-mix(in srgb, Highlight 50%, transparent));
	}
	/* The line can be see-through or thin against the app's colors: the system's ring says it has the keyboard. */
	:where([data-sd-splitter]:focus-visible) {
		outline: auto;
		outline-offset: -1px;
	}
	:where([data-sd-splitter][data-dragging])::after {
		background: var(--sd-pane-splitter-active, Highlight);
	}
	@media (prefers-reduced-motion: reduce) {
		:where([data-sd-splitter])::after {
			transition: none;
		}
	}
	:global(:where([data-sd-pane-resizing='row'])),
	:global(:where([data-sd-pane-resizing='row'] *)) {
		cursor: col-resize !important;
		user-select: none;
		-webkit-user-select: none;
	}
	:global(:where([data-sd-pane-resizing='column'])),
	:global(:where([data-sd-pane-resizing='column'] *)) {
		cursor: row-resize !important;
		user-select: none;
		-webkit-user-select: none;
	}
	:global(:where([data-sd-pane-dragging])),
	:global(:where([data-sd-pane-dragging] *)) {
		cursor: grabbing !important;
		user-select: none;
		-webkit-user-select: none;
	}
	/* Where a dragged tab will land: the room its view left. */
	:where([data-sd-pane-drop]) {
		position: absolute;
		pointer-events: none;
		background: var(--sd-pane-drop, color-mix(in srgb, Highlight 30%, transparent));
		border-radius: 4px;
	}
	:where([data-sd-pane-drop='center']) {
		inset: 0;
	}
	:where([data-sd-pane-drop='left']) {
		inset: 0 50% 0 0;
	}
	:where([data-sd-pane-drop='right']) {
		inset: 0 0 0 50%;
	}
	:where([data-sd-pane-drop='top']) {
		inset: 0 0 50% 0;
	}
	:where([data-sd-pane-drop='bottom']) {
		inset: 50% 0 0 0;
	}
	:where([data-sd-pane-drop-root][data-sd-pane-drop='left']) {
		inset: 0 75% 0 0;
	}
	:where([data-sd-pane-drop-root][data-sd-pane-drop='right']) {
		inset: 0 0 0 75%;
	}
	:where([data-sd-pane-drop-root][data-sd-pane-drop='bottom']) {
		inset: 75% 0 0 0;
	}
</style>
