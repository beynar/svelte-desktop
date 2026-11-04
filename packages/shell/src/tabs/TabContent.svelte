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
</script>

<!-- The page, unless a view is on screen; not rendered at a kept-alive route (its view runs it). -->
<div data-sd-tabcontent class={className} hidden={!tabs.pageShown}>
	{#if tabs.pageRendered}{@render children()}{/if}
</div>
{#each isolated as t (t.id)}
	{@const shown = t.id === tabs.shown}
	<div
		data-sd-tabview
		class={className}
		hidden={!shown}
		use:isolatedView={{ tabs, tab: t, active: t.id === tabs.activeId, shown, suspended: tabs.suspended.has(t.id) }}
	></div>
{/each}

<style>
	/* Hidden even with a display class (flex, grid) on it. */
	:global(:where([data-sd-tabcontent], [data-sd-tabview], [data-sd-tabpanel])[hidden]) {
		display: none !important;
	}
</style>
