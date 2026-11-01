<!--
	The content of a route `Tabs` group: the page (`children`, your `{@render children()}`) for the
	tabs that are routes of the page, and each isolated tab's own web view (kept alive, hidden
	while another tab is shown).

	<TabContent {tabs} class="h-full">{@render children()}</TabContent>
-->
<script lang="ts" generics="D = unknown">
	import type { Snippet } from 'svelte';
	import type { Tabs } from './tabs.svelte.ts';
	import { isolatedView } from './isolated.ts';

	interface Props {
		tabs: Tabs<D>;
		class?: string;
		children: Snippet;
	}

	let { tabs, class: className = '', children }: Props = $props();
	const isolated = $derived(tabs.items.filter((t) => t.isolated));
	const page = $derived(!tabs.active?.isolated);
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
