<!--
	The panels of a <Tabs> (internal: <Tabs> renders it as `content`). `mount`: 'lazy' renders the
	active panel only, 'once' keeps a panel after its first showing, 'eager' renders them all;
	inactive ones are hidden. An isolated tab shows its own web view instead.
-->
<script lang="ts" generics="T extends TabLike = TabLike & Record<string, any>">
	import type { Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { useTabs, type TabGroup, type TabLike } from './tabs.svelte.ts';
	import { isolatedView } from './isolated.ts';

	interface Props {
		mount?: 'lazy' | 'once' | 'eager';
		class?: string;
		children: Snippet<[{ item: any; index: number; api: TabGroup<T> }]>;
		itemOf?: (tab: T) => unknown;
	}

	let { mount = 'lazy', class: className = '', children, itemOf = (t) => t }: Props = $props();
	const tabs = useTabs<T>();
	const seen = new SvelteSet<string>();
	$effect.pre(() => void (tabs.activeId && seen.add(tabs.activeId)));
	// Rendered: the active panel, the one on screen while it comes (an isolated one loading), the
	// ones seen ('once') or all ('eager'). On screen: `tabs.shown` only.
	const mounted = $derived(
		mount === 'eager' ? tabs.items : tabs.items.filter((t) => t.id === tabs.activeId || t.id === tabs.shown || (mount === 'once' && seen.has(t.id))),
	);
</script>

{#each mounted as t (t.id)}
	{@const shown = t.id === tabs.shown}
	{#if tabs.isIsolated(t)}
		<div
			role="tabpanel"
			id={`${tabs.id}-panel-${t.id}`}
			aria-labelledby={`${tabs.id}-tab-${t.id}`}
			hidden={!shown}
			data-sd-tabpanel
			data-sd-tabview
			class={className}
			use:isolatedView={{ tabs, tab: t, active: t.id === tabs.activeId, shown, suspended: tabs.suspended.has(t.id) }}
		></div>
	{:else}
		<div
			role="tabpanel"
			id={`${tabs.id}-panel-${t.id}`}
			aria-labelledby={`${tabs.id}-tab-${t.id}`}
			hidden={!shown}
			data-sd-tabpanel
			class={className}
		>
			{@render children({ item: itemOf(t), index: tabs.items.findIndex((x) => x.id === t.id), api: tabs })}
		</div>
	{/if}
{/each}

<style>
	/* Hidden even with a display class (flex, grid) on it. */
	:global(:where([data-sd-tabcontent], [data-sd-tabview], [data-sd-tabpanel])[hidden]) {
		display: none !important;
	}
</style>
