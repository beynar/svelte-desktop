<!--
	A tab group, configured by its props: everything inside it — <TabBar>, <TabContent>,
	<TabPanels>, useTabs() — works on it. Its `children` snippet gets the group too.

	<Tabs id="app" route primary create={() => ({ path: '/' })}>
		{#snippet children(tabs)}
			<header class="titlebar"><TabBar label="Open pages" /></header>
			<TabContent>{@render page()}</TabContent>
		{/snippet}
	</Tabs>

	Groups nest: an inner <Tabs> (tabs inside a page) is the one its own content sees.
-->
<script lang="ts" generics="D = any">
	import type { Snippet } from 'svelte';
	import { TabGroup, setTabs, type TabsOptions } from './tabs.svelte.ts';

	interface Props extends TabsOptions<D> {
		children: Snippet<[TabGroup<D>]>;
	}

	// The options are the live props, read when they're used (windowAnimation when a tab leaves,
	// create on ⌘T…); `id`, `route` and `initial` are read once.
	const props: Props = $props();
	const group = setTabs(new TabGroup<D>(() => props));
	$effect(() => group.connect());
</script>

{@render props.children(group)}
