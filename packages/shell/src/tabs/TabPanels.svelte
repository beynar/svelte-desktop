<!--
	The content of a `Tabs` group, one panel per tab. `keepAlive` (default) keeps every panel
	mounted and hides the inactive ones, so each tab keeps its state (scroll, inputs, components);
	`keepAlive={false}` renders the active one only.

	<TabPanels {tabs}>
		{#snippet children(t)}<Board id={t.data.boardId} />{/snippet}
	</TabPanels>
-->
<script lang="ts" generics="D = unknown">
	import type { Snippet } from 'svelte';
	import type { Tab, Tabs } from './tabs.svelte.ts';

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
	<div
		role="tabpanel"
		id={`${tabs.id}-panel-${t.id}`}
		aria-labelledby={`${tabs.id}-tab-${t.id}`}
		hidden={t.id !== tabs.activeId}
		data-sd-tabpanel
		class={className}
	>
		{@render children(t)}
	</div>
{/each}
