<!--
	A tab group on your tabs: bind your array and the active id, and everything inside —
	<TabBar>, <TabContent>, <TabPanels>, useTabs() — shows them and changes them, on your array.
	Its `children` snippet gets the group too.

	<Tabs bind:tabs bind:active newTab={() => ({ title: 'New' })} onclose={(t) => confirm(`Close ${t.title}?`)}>
		<TabBar />
		<TabPanels>{#snippet children(tab)}…{/snippet}</TabPanels>
	</Tabs>

	Without bind:, `tabs` is where it starts. Groups nest: an inner <Tabs> is the one its content sees.
-->
<script lang="ts" generics="T extends TabLike = TabLike">
	import type { Snippet } from 'svelte';
	import { TabGroup, setTabs, type TabLike, type TabsOptions } from './tabs.svelte.ts';

	interface Props extends TabsOptions<T> {
		/** Your tabs (bind:tabs): closing, moving, adding, a tab from another window — your array. */
		tabs?: T[];
		/** The active tab's id (bind:active). */
		active?: string;
		children: Snippet<[TabGroup<T>]>;
	}

	let { tabs = $bindable(), active = $bindable(), ...options }: Props = $props();

	// The options are the live props, read when used (newTab on ⌘T, windowAnimation when a tab
	// leaves…); `id` and `route` are read once.
	const group = setTabs(
		new TabGroup<T>(() => options, {
			get items() {
				return tabs;
			},
			set items(next) {
				tabs = next;
			},
			get active() {
				return active;
			},
			set active(next) {
				active = next;
			},
		}),
	);
	$effect(() => group.connect());
</script>

{@render options.children(group)}
