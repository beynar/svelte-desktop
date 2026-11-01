<!--
	The content of a `Tabs` group, one panel per tab. `keepAlive` (default) keeps every panel
	mounted and hides the inactive ones, so each tab keeps its state (scroll, inputs, components);
	`keepAlive={false}` renders the active one only. An `isolated` tab shows its own web view
	(its `path` or `url`) instead of `children`.

	<TabPanels {tabs}>
		{#snippet children(t)}<Board id={t.data.boardId} />{/snippet}
	</TabPanels>
-->
<script lang="ts" generics="D = unknown">
	import type { Snippet } from 'svelte';
	import type { Tab, Tabs } from './tabs.svelte.ts';
	import { isolatedView } from './isolated.ts';

	interface Props {
		tabs: Tabs<D>;
		keepAlive?: boolean;
		class?: string;
		children: Snippet<[Tab<D>]>;
	}

	let { tabs, keepAlive = true, class: className = '', children }: Props = $props();
	const shown = $derived(keepAlive ? tabs.items : tabs.active ? [tabs.active] : []);
</script>

{#each shown as t (t.id)}
	{@const active = t.id === tabs.activeId}
	{#if t.isolated}
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
			{@render children(t)}
		</div>
	{/if}
{/each}

<style>
	/* Hidden even with a display class (flex, grid) on it. */
	:global(:where([data-sd-tabcontent], [data-sd-tabview], [data-sd-tabpanel])[hidden]) {
		display: none !important;
	}
</style>
