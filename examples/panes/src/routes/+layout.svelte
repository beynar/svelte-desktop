<script lang="ts">
	import '../app.css';
	import { invalidateAll } from '$app/navigation';
	import { page as current } from '$app/state';
	import { WindowTabs, type TabGroup, type TabLike } from '@svelte-desktop/shell/tabs';

	let { children } = $props();
	let tabs = $state<TabGroup<TabLike>>();
	let active = $state<string>();
	// For the tests: the tabs, and the active one set from outside.
	$effect(() => {
		Object.assign(globalThis, { __tabs: tabs, __setValue: (id: string) => (active = id), __invalidateAll: invalidateAll, __pageUrl: () => current.url.pathname, __pageState: () => current.state });
	});

	const threads = ['Voice models', 'Usage limits', 'Release notes', 'Native menus'];
	const pathOf = (i: number) => `/threads/${i + 1}`;
</script>

<!-- Every tab in its own web view. Drag one to a side of a pane to split it, or use ⌘\ and ⇧⌘\. -->
<WindowTabs page={children} newTab="/" split keepAlive={['/live', '/live/[id]', '/numbers/[n=int]']} prewarm={import.meta.env.VITE_PANES_PREWARM === '1'} bind:api={tabs} bind:value={active}>
	{#snippet layout({ content, api })}
		<div class="shell">
			<nav class="sidebar">
				<a href="/" aria-current={current.url.pathname === '/' ? 'page' : undefined}>Overview</a>
				<h2>Threads</h2>
				{#each threads as title, i}
					<!-- A link moves the active tab of the pane in focus; ⌘-click opens a tab. -->
					<a href={pathOf(i)} aria-current={current.url.pathname === pathOf(i) ? 'page' : undefined}>{title}</a>
				{/each}
				<!-- keepAlive: its one tab, wherever it is. -->
				<a href="/live" aria-current={current.url.pathname === '/live' ? 'page' : undefined}>Live</a>
				<h2>Panes</h2>
				<button onclick={() => api.split('right')}>Split right</button>
				<button onclick={() => api.split('bottom')}>Split down</button>
				<button onclick={() => api.open('https://svelte.dev/docs/svelte/overview', { split: 'right', reuse: false })}>Svelte docs, beside</button>
			</nav>
			{@render content({ class: 'panes', bar: { class: 'pane-bar', label: 'Open pages' } })}
		</div>
	{/snippet}

	<!-- A tab's own web view runs the app again: there it's the page alone. -->
	{#snippet embedded({ page })}
		<main class="page">{@render page()}</main>
	{/snippet}
</WindowTabs>
