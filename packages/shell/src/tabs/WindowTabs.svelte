<!--
	The window's tabs: SvelteKit routes in the title bar. Links, goto() and the sidebar move the
	active tab; ⌘-click, a middle click or target="_blank" open a tab; ⌘T and + open `newTab`; a
	`keepAlive` route keeps running in its own web view; titles are the pages' <title>; the
	Tab menu, ⌘W ⇧⌘T ⌃⇥ ⌘1–9, restore at launch, dragging a tab out into its own window.

	<WindowTabs {page} newTab="/" keepAlive={['/chat', '/terminal/[id]']}>
		{#snippet layout({ bar, content })}
			<header class="titlebar">{@render bar()}</header>
			<AppShell {sidebar}>{@render content()}</AppShell>
		{/snippet}
	</WindowTabs>

	In a kept-alive tab's own web view (the app again), it renders `page` alone.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { WindowAnimation } from '../platform/index';
	import { TabGroup, embedded as inView, setTabs, type TabLike, type TabRender } from './tabs.svelte.ts';
	import TabBar from './TabBar.svelte';
	import TabContent from './TabContent.svelte';

	type Tab = TabLike;
	type BarProps = { class?: string; label?: string; newTabLabel?: string; start?: Snippet; end?: Snippet };

	interface Props {
		/** The page: your layout's `children`. */
		page: Snippet;
		/** The page ⌘T and + open. Without it, no new tab. */
		newTab?: string;
		/** Routes that keep running when their tab isn't shown, as SvelteKit route ids. */
		keepAlive?: string[];
		/** Restore the tabs at the next launch. Default true. */
		restore?: boolean;
		/** Drag a tab out of the window (its own window, another window's bar). Default true. */
		detachable?: boolean | ((tab: Tab) => boolean);
		/** How the window a tab is dragged into comes in (macOS). Default true. */
		windowAnimation?: boolean | WindowAnimation;
		/** A tab is closing: return false to keep it. */
		beforeClose?: (event: { tab: Tab; index: number }) => boolean | void;
		/** The active tab changed. */
		onValueChange?: (event: { value: string; tab: Tab; index: number; reason: 'user' | 'missing' }) => void;
		/** The active tab's id (bindable). */
		value?: string;
		/** The tabs, for your code (bindable): items, active, open(path | url), close, activate… */
		api?: TabGroup<Tab>;
		/** Each tab (default: its title and a close button). */
		tab?: Snippet<[TabRender<Tab>]>;
		/** Where the bar and the content go (default: the bar above the content). */
		layout?: Snippet<[{ bar: Snippet<[BarProps?]>; content: Snippet<[{ class?: string }?]>; api: TabGroup<Tab> }]>;
		/** The page alone, in a kept-alive tab's own web view (default: just the page). */
		embedded?: Snippet<[{ page: Snippet }]>;
	}

	let {
		page,
		newTab,
		keepAlive,
		restore = true,
		detachable = true,
		windowAnimation,
		beforeClose,
		onValueChange,
		value = $bindable(),
		api = $bindable(),
		tab,
		layout,
		embedded: embeddedSnippet,
	}: Props = $props();

	let items = $state<Tab[]>([]);
	const group: TabGroup<Tab> = new TabGroup<Tab>(
		() => ({
			id: 'app',
			route: true,
			primary: true,
			restore,
			keepAlive,
			detachable,
			windowAnimation,
			newTab: newTab === undefined ? undefined : () => ({ path: newTab }),
			onclose: (t) => beforeClose?.({ tab: t, index: group.items.findIndex((x: Tab) => x.id === t.id) }),
			onactivate: (t, reason) => onValueChange?.({ value: t.id, tab: t, index: group.items.findIndex((x: Tab) => x.id === t.id), reason }),
		}),
		{
			get items() {
				return items;
			},
			set items(next) {
				items = next ?? [];
			},
			get active() {
				return value;
			},
			set active(next) {
				value = next;
			},
		},
	);
	// What `layout` gets: the bar and the content, to put where they go.
	const parts = () => ({ bar, content, api: group }) as unknown as Parameters<NonNullable<typeof layout>>[0];
	setTabs(group);
	api = group;
	$effect(() => group.connect());
</script>

{#snippet bar(props: BarProps = {})}
	<TabBar {...props} {tab} />
{/snippet}

{#snippet content(props: { class?: string } = {})}
	<TabContent class={props.class}>{@render page()}</TabContent>
{/snippet}

{#if inView}
	{#if embeddedSnippet}{@render embeddedSnippet({ page })}{:else}{@render page()}{/if}
{:else if layout}
	{@render layout(parts())}
{:else}
	{@render bar()}
	{@render content()}
{/if}
