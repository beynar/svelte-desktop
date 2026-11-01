<script lang="ts">
	import '../app.css';
	import { page as pageState } from '$app/state';
	import { Theme } from 'entasis/theme';
	import { AppShell, type AppShellSidebarProps } from 'entasis/app-shell';
	import type { SidebarDisplayState, SidebarGroup } from 'entasis/sidebar';
	import { squaresFourIcon } from 'entasis/icons/squaresFour';
	import { kanbanIcon } from 'entasis/icons/kanban';
	import { calendarIcon } from 'entasis/icons/calendar';
	import { sidebarIcon } from 'entasis/icons/sidebar';
	import { globeIcon } from 'entasis/icons/globe';
	import { Tabs, TabBar, TabContent } from '@svelte-desktop/shell/tabs';
	import { board, upcoming } from '#lib/data.svelte';
	import TabsTestHook from '#lib/TabsTestHook.svelte';

	let { children: page } = $props();

	const pages = {
		'/': { title: 'Overview', subtitle: 'What needs your attention today' },
		'/board': { title: 'Board', subtitle: 'Drag tasks between columns' },
		'/calendar': { title: 'Calendar', subtitle: 'Your week at a glance' }
	} as const;
	const pageOf = (path: string) => pages[path as keyof typeof pages] ?? pages['/'];
	const current = $derived(pageOf(pageState.url.pathname));
	const icons = { '/': squaresFourIcon, '/board': kanbanIcon, '/calendar': calendarIcon };

	let displayState = $state<SidebarDisplayState>('expanded');
	const openTasks = $derived(board.columns.filter((c) => c.id !== 'done').reduce((n, c) => n + c.cards.length, 0));

	const items: SidebarGroup[] = $derived([
		{
			label: 'Workspace',
			items: [
				{ label: 'Overview', href: '/', icon: squaresFourIcon, isActive: pageState.url.pathname === '/' },
				{ label: 'Board', href: '/board', icon: kanbanIcon, badge: openTasks, isActive: pageState.url.pathname === '/board' },
				{ label: 'Calendar', href: '/calendar', icon: calendarIcon, badge: upcoming().length, isActive: pageState.url.pathname === '/calendar' }
			]
		}
	]);

	const sidebar = $derived<AppShellSidebarProps>({
		displayState,
		onDisplayStateChange: (next) => (displayState = next),
		collapsible: 'icon',
		items,
		headerButton: { icon: squaresFourIcon, title: 'Acme', subtitle: 'Operations' }
	});
</script>

<Theme>
	<!-- The window's tabs, in the title bar: each one is a place in the app (⌘T, ⌘W, ⌘-click a link,
	     ⌃⇥, ⌘1–9, the Tab menu), restored at the next launch; a tab dragged out of the window opens in
	     its own window, which rises into place, growing a little. -->
	<Tabs
		route
		primary
		newTab={() => ({ path: '/' })}
		title={(url) => pageOf(url.pathname).title}
		windowAnimation={{ duration: 220, easing: [0.2, 0.9, 0.1, 1], offset: { y: 16 }, scale: 0.97 }}
	>
		{#snippet children(tabs)}
			{#if import.meta.env.DEV}<TabsTestHook />{/if}
			{#if tabs.embedded}
				<!-- An isolated tab's own web view (tabs.open({ path, isolated: true })): the page alone. -->
				<div class="h-full overflow-auto p-6">{@render page()}</div>
			{:else}
				<div class="app flex h-full flex-col">
					<header class="titlebar bg-surface-canvas flex shrink-0 items-end gap-2">
						<TabBar label="Open pages" class="app-tabs min-w-0 flex-1 gap-1">
							{#snippet tab(t, { active, close })}
								{@const icon = t.url ? globeIcon : (icons[new URL(t.path ?? '/', 'http://x').pathname as keyof typeof icons] ?? squaresFourIcon)}
								{@render icon({ class: `size-3.5 shrink-0 ${active ? 'text-primary' : 'text-neutral-readable'}` })}
								<span class="min-w-0 flex-1 truncate">{tabs.titleOf(t)}</span>
								<button
									type="button"
									aria-label={`Close ${tabs.titleOf(t)}`}
									class="tab-close state-layer grid size-4 shrink-0 place-items-center rounded text-xs"
									onmousedown={(e) => e.stopPropagation()}
									onclick={close}>✕</button
								>
							{/snippet}
						</TabBar>
					</header>
					<div class="min-h-0 flex-1">
						<AppShell
							variant="inset"
							{sidebar}
							title={tabs.active && tabs.isIsolated(tabs.active) ? tabs.titleOf(tabs.active) : current.title}
							subtitle={tabs.active?.url ? new URL(tabs.active.url).host : current.subtitle}
							contentWidth="full"
						>
							{#snippet headerActions({ sidebar })}
								<!-- An isolated tab: another site in its own web view (its own process), next to the app's tabs. -->
								<button
									type="button"
									class="state-layer border-neutral-muted text-neutral inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm"
									onclick={() => tabs.open({ id: 'docs', url: 'https://svelte.dev/docs/svelte/overview', title: 'Svelte docs' })}
								>
									{@render globeIcon({ class: 'size-4' })} Docs
								</button>
								<button
									type="button"
									class="state-layer border-neutral-muted text-neutral inline-flex size-8 items-center justify-center rounded-md border"
									aria-label="Toggle sidebar"
									onclick={sidebar.toggle}
								>
									{@render sidebarIcon({ class: 'size-4' })}
								</button>
							{/snippet}
							<TabContent class="h-full">{@render page()}</TabContent>
						</AppShell>
					</div>
				</div>
			{/if}
		{/snippet}
	</Tabs>
</Theme>
