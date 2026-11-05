<!--
	The bar of the <WindowTabs> around it: in the title bar, or in a pane with `split`.
	Clicking activates, a middle click or the × closes, dragging reorders (native drag and drop:
	a line shows where the tab lands) — and, for a detachable group, a tab dragged out of the
	window opens in its own window, or joins another window's bar — ←/→ move along. In an isolated tab's own web view it renders nothing.
	Unstyled but for layout: style it with `class` and the state attributes —
	[data-active], [data-pinned], [data-suspended], [data-dragging] on each [role=tab], [data-sd-tab-close],
	[data-sd-tab-new], [data-sd-tab-drop] (the drop line, colored by --sd-tab-drop-color) — or
	render each tab yourself with the `tab` snippet.

	<TabBar class="…">
		{#snippet tab(t, { active, close })}<span>{t.title}</span>{/snippet}
	</TabBar>
-->
<script lang="ts" generics="T extends TabLike = TabLike & Record<string, any>">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { useTabs, type TabLike, type TabRender } from './tabs.svelte.ts';
	import type { PaneLeaf } from './panes.svelte.ts';
	import { tabDrag, tabDrop } from './drag.ts';
	import { paneTabDrag } from './panes-drag.ts';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		/** Each tab's content (default: its title and a close button). */
		tab?: Snippet<[TabRender]>;
		/** Before / after the tabs (the + button follows the last tab). */
		start?: Snippet;
		end?: Snippet;
		/** Accessible name of the bar and of its + button. */
		label?: string;
		newTabLabel?: string;
		/** The bar of this pane: its tabs (<WindowTabs split>). */
		pane?: PaneLeaf;
	}

	let { tab, start, end, label = 'Tabs', newTabLabel = 'New tab', pane, class: className = '', ...rest }: Props = $props();
	// A press on a control inside a tab (its close button, a rename field) doesn't activate it.
	const onControl = (e: MouseEvent) => e.target instanceof Element && e.target.closest('button, input, textarea, select, a[href], [contenteditable]') !== null;
	const tabs = useTabs<T>();

	// Panes: dragged with the pointer (their web views can't hear a native drag over them). A press keeps
	// the keyboard in the page until it's let go: Escape cancels the drag, it isn't for a view.
	const drag = (node: HTMLElement, params: Parameters<typeof tabDrag>[1]) => (tabs.panes ? paneTabDrag(node, params) : tabDrag(node, params));
	const drop = (node: HTMLElement, params: Parameters<typeof tabDrop>[1]) => (tabs.panes ? undefined : tabDrop(node, params));
	const list = $derived(pane ? pane.tabs.map((id) => tabs.get(id)).filter((t): t is T => !!t) : tabs.items);
	const activeId = $derived(pane ? pane.active : tabs.activeId);

	let dragging = $state<string | null>(null);
	/** The drop indicator's place while a tab is dragged over the bar (px), or null. */
	let indicator = $state<number | null>(null);
	const indicate = (x: number | null) => (indicator = x);
	const line = $derived.by(() => {
		if (!pane) return indicator;
		const d = tabs.panes?.drop;
		return d?.kind === 'bar' && d.pane === pane.id ? d.x : null;
	});
	const elementId = (t: T) => `${tabs.id}-tab-${t.id}`;

	// A full bar in a pane: the tab it shows stays in sight, whichever way it got there.
	$effect(() => {
		const id = pane ? activeId : null;
		if (id) document.getElementById(`${tabs.id}-tab-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});

	function keydown(e: KeyboardEvent, t: T) {
		const i = list.findIndex((x) => x.id === t.id);
		const flip = pane && tabs.panes?.rtl ? -1 : 1; // the arrow that points at it
		const to = e.key === 'ArrowRight' ? i + flip : e.key === 'ArrowLeft' ? i - flip : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
		const next = list[to];
		if (!next) return;
		e.preventDefault();
		tabs.activate(next.id, 'user', { keyboard: false });
		document.getElementById(elementId(next))?.focus();
	}
</script>

{#if !tabs.embedded}
	<div
		role="tablist"
		aria-label={label}
		data-sd-tabbar
		class={className}
		use:drop={{ tabs, indicate }}
		{...rest}
	>
		{@render start?.()}
		<div data-sd-tabs>
			{#each list as t, i (t.id)}
				{@const active = t.id === activeId}
				<div
					role="tab"
					id={elementId(t)}
					aria-selected={active}
					tabindex={active ? 0 : -1}
					title={tabs.titleOf(t)}
					data-active={active || undefined}
					data-pinned={t.pinned || undefined}
					data-suspended={tabs.suspended.has(t.id) || undefined}
					data-dragging={dragging === t.id || undefined}
					use:drag={{ tabs, tab: t, dragging: (on) => (dragging = on ? t.id : null) }}
					onmousedown={(e) => e.button === 0 && !onControl(e) && tabs.activate(t.id, 'user', pane && !t.pinned ? { keyboard: false } : {})}
					onauxclick={(e) => e.button === 1 && (e.preventDefault(), tabs.close(t.id))}
					onkeydown={(e) => keydown(e, t)}
				>
					{#if tab}
						{@render tab({ tab: t, index: i, active, closable: tabs.isClosable(t) && !t.pinned, close: () => tabs.close(t.id) })}
					{:else}
						<span data-sd-tab-title>{tabs.titleOf(t)}</span>
						{#if tabs.isClosable(t) && !t.pinned}
							<button
								type="button"
								data-sd-tab-close
								aria-label={`Close ${tabs.titleOf(t)}`}
								tabindex="-1"
								onclick={() => tabs.close(t.id)}>×</button
							>
						{/if}
					{/if}
				</div>
			{/each}
			{#if line !== null}
				<span data-sd-tab-drop aria-hidden="true" style:left="{line}px"></span>
			{/if}
			{#if tabs.canCreate && !pane}
				<button type="button" data-sd-tab-new aria-label={newTabLabel} title={newTabLabel} onclick={() => tabs.new()}>+</button>
			{/if}
		</div>
		<!-- In a pane the bar is often narrow: + stays in reach, out of what scrolls. -->
		{#if tabs.canCreate && pane}
			<button type="button" data-sd-tab-new aria-label={newTabLabel} title={newTabLabel} onclick={() => tabs.new({ pane: pane.id })}>+</button>
		{/if}
		{@render end?.()}
	</div>
{/if}

<style>
	/* Layout only, at zero specificity: the app's classes win. */
	:where([data-sd-tabbar]) {
		display: flex;
		align-items: center;
		min-width: 0;
	}
	/* The tabs take the room there is (shrinking when crowded), the + right after the last one. */
	:where([data-sd-tabs]) {
		display: flex;
		align-items: center;
		gap: inherit; /* the bar's gap spaces the tabs too */
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
	}
	:where([data-sd-tabs] > [role='tab']) {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 0 1 12rem;
		min-width: 4.5rem;
		cursor: default;
		user-select: none;
		-webkit-user-select: none;
	}
	:where([data-sd-tab-title]) {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	:where([data-sd-tab-new]) {
		flex: none;
	}
	/* In a pane: only as wide as its tabs, the + right after them. */
	:where([data-sd-pane] > [data-sd-tabbar] > [data-sd-tabs]) {
		flex: 0 1 auto;
	}
	:where([data-sd-tab-close], [data-sd-tab-new]) {
		font: inherit;
		color: inherit;
		background: none;
		border: 0;
		cursor: default;
	}
	:where([data-sd-tabs] > [role='tab']:not([data-active]):not(:hover) [data-sd-tab-close]) {
		visibility: hidden;
	}
	:where([data-dragging]) {
		opacity: 0.5;
	}
	/* Where a dragged tab will land. */
	:where([data-sd-tabs]) {
		position: relative;
	}
	:where([data-sd-tab-drop]) {
		position: absolute;
		top: 20%;
		bottom: 20%;
		width: 2px;
		margin-left: -1px;
		border-radius: 1px;
		background: var(--sd-tab-drop-color, Highlight);
		pointer-events: none;
	}
</style>
