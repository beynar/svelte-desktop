<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { Theme } from 'entasis/theme';
	import { AppShell, type AppShellSidebarProps } from 'entasis/app-shell';
	import type { SidebarDisplayState, SidebarGroup } from 'entasis/sidebar';
	import { squaresFourIcon } from 'entasis/icons/squaresFour';
	import { kanbanIcon } from 'entasis/icons/kanban';
	import { calendarIcon } from 'entasis/icons/calendar';
	import { sidebarIcon } from 'entasis/icons/sidebar';
	import { Tabs, TabBar } from '@svelte-desktop/shell/tabs';
	import { board, upcoming } from '#lib/data.svelte';

	let { children } = $props();

	const pages = {
		'/': { title: 'Overview', subtitle: 'What needs your attention today' },
		'/board': { title: 'Board', subtitle: 'Drag tasks between columns' },
		'/calendar': { title: 'Calendar', subtitle: 'Your week at a glance' }
	} as const;
	const pageOf = (path: string) => pages[path as keyof typeof pages] ?? pages['/'];
	const current = $derived(pageOf(page.url.pathname));
	const icons = { '/': squaresFourIcon, '/board': kanbanIcon, '/calendar': calendarIcon };

	// The window's tabs, in the title bar: each one is a place in the app (⌘T, ⌘W, ⌘-click a link,
	// ⌃⇥, ⌘1–9, the Tab menu), restored at the next launch.
	const tabs = new Tabs({
		id: 'app',
		route: true,
		primary: true,
		create: () => ({ path: '/' }),
		onLastClose: 'new',
		title: (url) => pageOf(url.pathname).title
	});

	let displayState = $state<SidebarDisplayState>('expanded');
	const openTasks = $derived(board.columns.filter((c) => c.id !== 'done').reduce((n, c) => n + c.cards.length, 0));

	const items: SidebarGroup[] = $derived([
		{
			label: 'Workspace',
			items: [
				{ label: 'Overview', href: '/', icon: squaresFourIcon, isActive: page.url.pathname === '/' },
				{ label: 'Board', href: '/board', icon: kanbanIcon, badge: openTasks, isActive: page.url.pathname === '/board' },
				{ label: 'Calendar', href: '/calendar', icon: calendarIcon, badge: upcoming().length, isActive: page.url.pathname === '/calendar' }
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
<div class="app flex h-full flex-col">
	<header class="titlebar bg-surface-canvas flex shrink-0 items-end gap-2">
		<TabBar {tabs} label="Open pages" class="app-tabs min-w-0 flex-1 gap-1">
			{#snippet tab(t, { active, close })}
				{@const icon = icons[new URL(t.path ?? '/', 'http://x').pathname as keyof typeof icons] ?? squaresFourIcon}
				{@render icon({ class: `size-3.5 shrink-0 ${active ? 'text-primary' : 'text-neutral-readable'}` })}
				<span class="min-w-0 flex-1 truncate">{t.title}</span>
				<button
					type="button"
					aria-label={`Close ${t.title}`}
					class="tab-close state-layer grid size-4 shrink-0 place-items-center rounded text-xs"
					onmousedown={(e) => e.stopPropagation()}
					onclick={close}>✕</button
				>
			{/snippet}
		</TabBar>
	</header>
	<div class="min-h-0 flex-1">
	<AppShell variant="inset" {sidebar} title={current.title} subtitle={current.subtitle} contentWidth="full">
		{#snippet headerActions({ sidebar })}
			<button
				type="button"
				class="state-layer border-neutral-muted text-neutral inline-flex size-8 items-center justify-center rounded-md border"
				aria-label="Toggle sidebar"
				onclick={sidebar.toggle}
			>
				{@render sidebarIcon({ class: 'size-4' })}
			</button>
		{/snippet}
		{@render children()}
	</AppShell>
	</div>
</div>
</Theme>
