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
	const shown = $derived(
		mount === 'eager' ? tabs.items : tabs.items.filter((t) => t.id === tabs.activeId || (mount === 'once' && seen.has(t.id))),
	);
</script>

{#each shown as t (t.id)}
	{@const active = t.id === tabs.activeId}
	{#if tabs.isIsolated(t)}
		<div
			role="tabpanel"
			id={`${tabs.id}-panel-${t.id}`}
			aria-labelledby={`${tabs.id}-tab-${t.id}`}
			hidden={!active}
			data-sd-tabpanel
			data-sd-tabview
			class={className}
			use:isolatedView={{ tabs, tab: t, active }}
		></div>
	{:else}
		<div
			role="tabpanel"
			id={`${tabs.id}-panel-${t.id}`}
			aria-labelledby={`${tabs.id}-tab-${t.id}`}
			hidden={!active}
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
