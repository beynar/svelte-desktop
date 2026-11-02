<!--
	Tabs in a page, on your items: a bar and a panel per tab.

	<Tabs bind:items={boards} bind:value mount="once" closable reorderable onAdd={() => newBoard()}>
		{#snippet children({ item })}<Board id={item.value} />{/snippet}
	</Tabs>

	An item is a string, or `{ value, label }` plus `pinned`, `closable` and your own fields.
	Adding, closing and reordering write back to `bind:items`. `layout` places the bar and the
	panels yourself; `tab` draws each tab.
-->
<script lang="ts" generics="Item extends TabItem">
	import type { Snippet } from 'svelte';
	import { TabGroup, setTabs, type TabItem, type TabLike, type TabRender } from './tabs.svelte.ts';
	import TabBar from './TabBar.svelte';
	import TabPanels from './TabPanels.svelte';

	type Tab = TabLike & { item: Item };
	type BarProps = { class?: string; label?: string; newTabLabel?: string; start?: Snippet; end?: Snippet };

	interface Props {
		/** Your tabs (bindable: adding, closing and reordering write back). */
		items: Item[];
		/** The active tab's value (bindable). Default: the first tab's. */
		value?: string;
		/** When a panel is made: 'lazy' (when shown, gone when left), 'once' (kept after its first
		 *  showing), 'eager' (all at once). Default 'lazy'. */
		mount?: 'lazy' | 'once' | 'eager';
		/** A new tab (the + button). Without it, no +. */
		onAdd?: () => Item;
		/** A tab is closing: return false to keep it. */
		beforeClose?: (event: { item: Item; index: number }) => boolean | void;
		/** The tabs show a close button (or decide per item). Default false. */
		closable?: boolean | ((item: Item) => boolean);
		/** Tabs can be dragged to another place. Default false. */
		reorderable?: boolean;
		/** Save the tabs and the active one under this name, restored at the next launch. */
		persist?: string;
		/** The active tab changed: 'user', or 'missing' (the active one was closed). */
		onValueChange?: (event: { value: string; item: Item; index: number; reason: 'user' | 'missing' }) => void;
		/** Accessible name of the bar. */
		label?: string;
		/** The bar's class. */
		class?: string;
		/** Your code's handle (bindable): activate, close, new… */
		api?: TabGroup<Tab>;
		/** Each tab (default: its label and, when closable, a close button). */
		tab?: Snippet<[TabRender<Item>]>;
		/** A tab's panel. */
		children?: Snippet<[{ item: Item; index: number; api: TabGroup<Tab> }]>;
		/** Where the bar and the panels go (default: the bar above the panels). */
		layout?: Snippet<[{ bar: Snippet<[BarProps?]>; content: Snippet<[{ class?: string }?]>; api: TabGroup<Tab> }]>;
	}

	let {
		items = $bindable(),
		value = $bindable(),
		mount = 'lazy',
		onAdd,
		beforeClose,
		closable = false,
		reorderable = false,
		persist,
		onValueChange,
		label,
		class: className,
		api = $bindable(),
		tab,
		children,
		layout,
	}: Props = $props();

	const valueOf = (item: Item, index: number): string =>
		typeof item === 'string' ? item : (item.value ?? (typeof item.label === 'string' ? item.label : String(index)));
	const labelOf = (item: Item): string => (typeof item === 'string' ? item : String(item.label));
	const closableOf = (item: Item): boolean =>
		typeof item === 'object' && item.closable !== undefined ? item.closable : typeof closable === 'function' ? closable(item) : closable;
	const wrap = (item: Item, index: number): Tab => ({
		id: valueOf(item, index),
		title: labelOf(item),
		pinned: typeof item === 'object' && !!item.pinned,
		closable: closableOf(item),
		item,
	});
	const indexOf = (t: Tab) => (items ?? []).findIndex((item, i) => valueOf(item, i) === t.id);

	const group: TabGroup<Tab> = new TabGroup<Tab>(
		() => ({
			id: persist,
			restore: !!persist,
			reorderable,
			newTab: onAdd && (() => wrap(onAdd(), items?.length ?? 0)),
			onclose: (t) => beforeClose?.({ item: t.item, index: indexOf(t) }),
			onactivate: (t, reason) => onValueChange?.({ value: t.id, item: t.item, index: indexOf(t), reason }),
		}),
		{
			get items() {
				return (items ?? []).map(wrap);
			},
			set items(next) {
				items = (next ?? []).map((t) => t.item);
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
	<TabBar label={label ?? 'Tabs'} class={className} {...props} {tab} itemOf={(t: Tab) => t.item} />
{/snippet}

{#snippet content(props: { class?: string } = {})}
	{#if children}
		<TabPanels {mount} class={props.class} itemOf={(t: Tab) => t.item} {children} />
	{/if}
{/snippet}

{#if layout}
	{@render layout(parts())}
{:else}
	{@render bar()}
	{@render content()}
{/if}
