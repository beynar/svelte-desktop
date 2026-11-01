<!--
	A tab bar for a `Tabs` group: in the title bar (the window's tabs) or anywhere in a page.
	Clicking activates, a middle click or the × closes, dragging reorders — and, for a detachable
	group, dragging a tab out of the bar opens it in its own window (or moves it onto another
	window's bar) — ←/→ move along. In an isolated tab's own web view it renders nothing.
	Unstyled but for layout: style it with `class` and the state attributes —
	[data-active], [data-pinned], [data-dragging] on each [role=tab], [data-sd-tab-close],
	[data-sd-tab-new] — or render each tab yourself with the `tab` snippet.

	<TabBar {tabs} class="…">
		{#snippet tab(t, { active, close })}<span>{t.title}</span>{/snippet}
	</TabBar>
-->
<script lang="ts" generics="D = unknown">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Tab, Tabs } from './tabs.svelte.ts';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		tabs: Tabs<D>;
		/** Each tab's content (default: its title and a close button). */
		tab?: Snippet<[Tab<D>, { active: boolean; close: () => void }]>;
		/** Before / after the tabs (the + button follows the last tab). */
		start?: Snippet;
		end?: Snippet;
		/** Accessible name of the bar and of its + button. */
		label?: string;
		newTabLabel?: string;
	}

	let { tabs, tab, start, end, label = 'Tabs', newTabLabel = 'New tab', class: className = '', ...rest }: Props = $props();

	$effect(() => tabs.connect());

	let dragging = $state<string | null>(null);
	/** Outside the bar: dropping there detaches the tab. */
	let detaching = $state(false);
	let bar = $state<HTMLDivElement>()!;
	let press: { id: string; x: number; y: number; pointer: number } | null = null;
	/** While dragging: the bar's box, and the middles of the other tabs (measured again after a move). */
	let barBox: DOMRect;
	let middles: number[] | null = null;
	const elementId = (t: Tab<D>) => `${tabs.id}-tab-${t.id}`;

	function keydown(e: KeyboardEvent, t: Tab<D>) {
		const i = tabs.items.indexOf(t);
		const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.items.length - 1 : -1;
		const next = tabs.items[to];
		if (!next) return;
		e.preventDefault();
		tabs.activate(next.id);
		document.getElementById(elementId(next))?.focus();
	}

	// Dragging with pointer events, captured by the bar (it doesn't move while tabs reorder): the
	// tabs follow the pointer, and a tab let go away from the bar leaves it.
	function pointerdown(e: PointerEvent, t: Tab<D>) {
		if (e.button !== 0 || t.pinned) return;
		press = { id: t.id, x: e.clientX, y: e.clientY, pointer: e.pointerId };
	}
	function pointermove(e: PointerEvent) {
		if (!press || e.pointerId !== press.pointer) return;
		if (!dragging) {
			if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) return;
			dragging = press.id;
			barBox = bar.getBoundingClientRect();
			middles = null;
			try {
				bar.setPointerCapture(e.pointerId); // keeps the moves coming outside the bar (and the window)
			} catch {}
		}
		const tab = tabs.get(dragging);
		if (!tab) return;
		detaching = tabs.canDetach(tab) && (e.clientY < barBox.top - 24 || e.clientY > barBox.bottom + 24 || e.clientX < 0 || e.clientX > innerWidth);
		if (detaching) return;
		// Its place: after every other tab whose middle is left of the pointer (never before a pinned one).
		middles ??= [...bar.querySelectorAll<HTMLElement>('[data-sd-tabs] > [role=tab]')]
			.filter((el) => el.id !== elementId(tab))
			.map((el) => {
				const b = el.getBoundingClientRect();
				return b.left + b.width / 2;
			});
		const index = Math.max(
			middles.filter((m) => e.clientX > m).length,
			tabs.items.filter((t) => t.pinned).length,
		);
		if (index !== tabs.items.indexOf(tab)) {
			tabs.move(tab.id, index);
			middles = null;
		}
	}
	function pointerup(e: PointerEvent) {
		if (!press || e.pointerId !== press.pointer) return;
		const id = dragging;
		if (id && detaching) void tabs.detach(id, { x: e.screenX, y: e.screenY });
		press = null;
		dragging = null;
		detaching = false;
	}
</script>

{#if !tabs.embedded}
	<div
		role="tablist"
		aria-label={label}
		data-sd-tabbar
		data-detaching={detaching || undefined}
		class={className}
		bind:this={bar}
		onpointermove={pointermove}
		onpointerup={pointerup}
		onpointercancel={pointerup}
		{...rest}
	>
		{@render start?.()}
		<div data-sd-tabs>
			{#each tabs.items as t (t.id)}
				{@const active = t.id === tabs.activeId}
				<div
					role="tab"
					id={elementId(t)}
					aria-selected={active}
					aria-controls={tabs.options.route ? undefined : `${tabs.id}-panel-${t.id}`}
					tabindex={active ? 0 : -1}
					title={t.title}
					data-active={active || undefined}
					data-pinned={t.pinned || undefined}
					data-dragging={dragging === t.id || undefined}
					onpointerdown={(e) => pointerdown(e, t)}
					onmousedown={(e) => e.button === 0 && tabs.activate(t.id)}
					onauxclick={(e) => e.button === 1 && (e.preventDefault(), tabs.close(t.id))}
					onkeydown={(e) => keydown(e, t)}
				>
					{#if tab}
						{@render tab(t, { active, close: () => tabs.close(t.id) })}
					{:else}
						<span data-sd-tab-title>{t.title}</span>
						{#if t.closable && !t.pinned}
							<button
								type="button"
								data-sd-tab-close
								aria-label={`Close ${t.title}`}
								tabindex="-1"
								onmousedown={(e) => e.stopPropagation()}
								onclick={() => tabs.close(t.id)}>×</button
							>
						{/if}
					{/if}
				</div>
			{/each}
			{#if tabs.canCreate}
				<button type="button" data-sd-tab-new aria-label={newTabLabel} title={newTabLabel} onclick={() => tabs.new()}>+</button>
			{/if}
		</div>
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
		opacity: 0.6;
	}
	:where([data-detaching] [data-dragging]) {
		opacity: 0.3;
	}
</style>
