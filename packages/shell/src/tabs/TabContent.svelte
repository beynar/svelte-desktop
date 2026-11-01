<!--
	The content of the route <Tabs> around it: the page (`children`, your `{@render children()}`) for the
	tabs that are routes of the page, and each isolated tab's own web view (kept alive, hidden
	while another tab is shown).

	<TabContent class="h-full">{@render children()}</TabContent>
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { useTabs } from './tabs.svelte.ts';
	import { isolatedView } from './isolated.ts';

	interface Props {
		class?: string;
		children: Snippet;
	}

	let { class: className = '', children }: Props = $props();
	const tabs = useTabs();
	const isolated = $derived(tabs.items.filter((t) => tabs.isIsolated(t)));
	const page = $derived(!tabs.active || !tabs.isIsolated(tabs.active));
</script>

<div data-sd-tabcontent class={className} hidden={!page}>
	{@render children()}
</div>
{#each isolated as t (t.id)}
	{@const active = t.id === tabs.activeId}
	<div
		data-sd-tabview
		class={className}
		hidden={!active}
		use:isolatedView={{ tabs, tab: t, active }}
	></div>
{/each}

<style>
	/* Hidden even with a display class (flex, grid) on it. */
	:global(:where([data-sd-tabcontent], [data-sd-tabview], [data-sd-tabpanel])[hidden]) {
		display: none !important;
	}
</style>
