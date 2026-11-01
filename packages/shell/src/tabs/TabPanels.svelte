<!--
	The content of the <Tabs> around it, one panel per tab. `keepAlive` (default) keeps every panel
	mounted and hides the inactive ones, so each tab keeps its state (scroll, inputs, components);
	`keepAlive={false}` renders the active one only. An `isolated` tab shows its own web view
	(its `path` or `url`) instead of `children`.

	<TabPanels>
		{#snippet children(t)}<Board id={t.data.boardId} />{/snippet}
	</TabPanels>
-->
<script lang="ts" generics="T extends TabLike = TabLike & Record<string, any>">
	import type { Snippet } from 'svelte';
	import { useTabs, type TabLike } from './tabs.svelte.ts';
	import { isolatedView } from './isolated.ts';

	interface Props {
		keepAlive?: boolean;
		class?: string;
		children: Snippet<[T]>;
	}

	let { keepAlive = true, class: className = '', children }: Props = $props();
	const tabs = useTabs<T>();
	const shown = $derived(keepAlive ? tabs.items : tabs.active ? [tabs.active] : []);
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
